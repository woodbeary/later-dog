export const DICTATION_SAMPLE_RATE = 16_000;
const FRAME = 4096;

export interface MicRecorder {
  stop(): Promise<Uint8Array<ArrayBuffer> | null>;
  cancel(): void;
}

export class MicUnavailableError extends Error {
  constructor(readonly reason: "unsupported" | "denied" | "failed") {
    super(reason);
  }
}

export function micRecordingSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof (globalThis as { AudioContext?: unknown }).AudioContext === "function";
}

export async function startMicRecorder(onLevel?: (level: number) => void): Promise<MicRecorder> {
  if (!micRecordingSupported()) throw new MicUnavailableError("unsupported");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    throw new MicUnavailableError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed");
  }
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(FRAME, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event) => {
    const samples = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(samples));
    if (onLevel) {
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i]! * samples[i]!;
      onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
    }
  };
  source.connect(processor);
  processor.connect(context.destination);
  if (context.state === "suspended") await context.resume().catch(() => {});

  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };
  return {
    async stop() {
      if (done) return null;
      const rate = context.sampleRate;
      release();
      const samples = joinChunks(chunks);
      if (samples.length >= rate / 2 && samples.every((sample) => sample === 0)) throw new MicUnavailableError("denied");
      return samples.length ? encodeWav(resample(samples, rate, DICTATION_SAMPLE_RATE), DICTATION_SAMPLE_RATE) : null;
    },
    cancel: release,
  };
}

function joinChunks(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += samples[j]!;
    out[i] = sum / (end - start);
  }
  return out;
}

export function encodeWav(samples: Float32Array, rate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < 4; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}
