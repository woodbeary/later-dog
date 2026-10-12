import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
    let line = String(data: data, encoding: .utf8)
  {
    print(line)
    fflush(stdout)
  }
}

var recordFile: AVAudioFile?
let recordLock = NSLock()
func closeRecording() {
  recordLock.lock()
  recordFile = nil
  recordLock.unlock()
}

func fail(_ message: String) -> Never {
  closeRecording()
  emit(["error": message])
  exit(1)
}

func argValue(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}
let recordPath = argValue("--record")
let filePath = argValue("--file")

let endpointMs: Int = {
  let args = CommandLine.arguments
  guard
    let index = args.firstIndex(of: "--endpoint-ms"),
    index + 1 < args.count,
    let value = Int(args[index + 1])
  else { return 0 }
  return min(5_000, max(250, value))
}()

let stopFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--stop-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

let finishFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--finish-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

var stopTimer: DispatchSourceTimer?
if let stopFile {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
  timer.setEventHandler {
    if FileManager.default.fileExists(atPath: stopFile) {
      closeRecording()
      exit(0)
    }
  }
  stopTimer = timer
  timer.resume()
}

var finishHandler: (() -> Void)?
var finishTimer: DispatchSourceTimer?
if let finishFile {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
  timer.setEventHandler {
    guard FileManager.default.fileExists(atPath: finishFile), let finish = finishHandler else { return }
    timer.cancel()
    finish()
  }
  finishTimer = timer
  timer.resume()
}

final class SilenceEndpointer {
  private let queue = DispatchQueue(label: "com.laterdog.speech.endpoint")
  private let gap: TimeInterval
  private let finish: () -> Void
  private var timer: DispatchSourceTimer?
  private var lastText = ""
  private var lastChange = DispatchTime.now()
  private var finished = false

  init(gapMs: Int, finish: @escaping () -> Void) {
    gap = Double(gapMs) / 1_000
    self.finish = finish
  }

  func start() {
    let source = DispatchSource.makeTimerSource(queue: queue)
    source.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    source.setEventHandler { [weak self] in self?.tick() }
    timer = source
    source.resume()
  }

  func saw(_ text: String) {
    queue.async {
      guard !self.finished, !text.isEmpty, text != self.lastText else { return }
      self.lastText = text
      self.lastChange = .now()
    }
  }

  private func tick() {
    guard !finished, !lastText.isEmpty else { return }
    let silentFor = Double(DispatchTime.now().uptimeNanoseconds - lastChange.uptimeNanoseconds) / 1_000_000_000
    guard silentFor >= gap else { return }
    finished = true
    timer?.cancel()
    timer = nil
    finish()
  }
}

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else { fail("speech-not-authorized") }
  let candidates =
    Locale.preferredLanguages.map { Locale(identifier: $0) }
    + [Locale.current, Locale(identifier: "en-US")]
  guard
    let recognizer = candidates.lazy.compactMap({ SFSpeechRecognizer(locale: $0) })
      .first(where: { $0.isAvailable })
  else { fail("recognizer-unavailable") }

  if let filePath {
    let fileRequest = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: filePath))
    fileRequest.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { fileRequest.requiresOnDeviceRecognition = true }
    recognizer.recognitionTask(with: fileRequest) { result, error in
      if let result = result {
        emit(["partial": !result.isFinal, "text": result.bestTranscription.formattedString])
        if result.isFinal { exit(0) }
      }
      if error != nil { fail("recognition-error") }
    }
    return
  }

  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  }

  let engine = AVAudioEngine()
  let node = engine.inputNode
  var audioFinished = false
  let finishAudio = {
    DispatchQueue.main.async {
      guard !audioFinished else { return }
      audioFinished = true
      engine.stop()
      node.removeTap(onBus: 0)
      request.endAudio()
    }
  }
  finishHandler = finishAudio
  var endpointer: SilenceEndpointer?
  if endpointMs > 0 {
    endpointer = SilenceEndpointer(gapMs: endpointMs) {
      finishAudio()
    }
    endpointer?.start()
  }
  let inputFormat = node.outputFormat(forBus: 0)
  if let recordPath {
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: inputFormat.sampleRate,
      AVNumberOfChannelsKey: inputFormat.channelCount,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
    ]
    recordFile = try? AVAudioFile(
      forWriting: URL(fileURLWithPath: recordPath), settings: settings,
      commonFormat: inputFormat.commonFormat, interleaved: inputFormat.isInterleaved)
  }
  node.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { buffer, _ in
    request.append(buffer)
    recordLock.lock()
    try? recordFile?.write(from: buffer)
    recordLock.unlock()
  }
  do {
    engine.prepare()
    try engine.start()
  } catch { fail("mic-failed") }

  recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      let text = result.bestTranscription.formattedString
      endpointer?.saw(text)
      emit(["partial": !result.isFinal, "text": text])
      if result.isFinal {
        closeRecording()
        exit(0)
      }
    }
    if let error {
      let nsError = error as NSError
      if nsError.domain == "kLSRErrorDomain" && nsError.code == 201 {
        fail("dictation-disabled")
      }
      fail("recognition-error")
    }
  }
}

RunLoop.main.run()
