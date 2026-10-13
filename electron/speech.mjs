import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

import {
  buildSpeechHelper,
  speechHelperBinary,
  speechHelperBundle,
} from "./build-speech-helper.mjs";
import { speechTranscript } from "./speech-transcript.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "resources", "speech-helper.swift");
const INFO = path.join(__dirname, "resources", "speech-helper-Info.plist");
const BUNDLE = app.isPackaged
  ? path.join(process.resourcesPath, "later.dog Speech.app")
  : speechHelperBundle;
const BIN = app.isPackaged
  ? path.join(BUNDLE, "Contents", "MacOS", "speech-helper")
  : speechHelperBinary;

let child = null;

const VOICE_NOTES_KEPT = 10;
const STOP_WAIT_MS = 3_000;
const CONVERT_TIMEOUT_MS = 30_000;
export function voiceNotesDir() {
  return path.join(app.getPath("userData"), "voice-notes");
}
function newVoiceNotePath() {
  const dir = voiceNotesDir();
  mkdirSync(dir, { recursive: true });
  try {
    const old = readdirSync(dir).filter((name) => name.endsWith(".caf")).sort();
    for (const name of old.slice(0, Math.max(0, old.length - (VOICE_NOTES_KEPT - 1)))) {
      rmSync(path.join(dir, name), { force: true });
    }
  } catch {}
  return path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.caf`);
}
export function isVoiceNote(file) {
  if (typeof file !== "string" || !file.endsWith(".caf")) return false;
  const resolved = path.resolve(file);
  return path.dirname(resolved) === voiceNotesDir() && existsSync(resolved);
}

function ensureBuilt() {
  if (app.isPackaged) return;
  const binaryMtime = existsSync(BIN) ? statSync(BIN).mtimeMs : 0;
  const stale = binaryMtime < Math.max(statSync(SRC).mtimeMs, statSync(INFO).mtimeMs);
  if (!stale) return;
  buildSpeechHelper();
}

function sendEnd(win, info) {
  if (!win.isDestroyed()) win.webContents.send("speech:end", info);
}

export function startSpeech(win, options = {}) {
  stopSpeech();
  if (process.platform !== "darwin") {
    sendEnd(win, { code: 2, reason: "unsupported-platform" });
    return;
  }
  const requested = Number(options?.endpointMs);
  const endpointMs = Number.isFinite(requested) && requested > 0
    ? Math.min(5_000, Math.max(250, Math.round(requested)))
    : 0;
  const file = isVoiceNote(options?.file) ? path.resolve(options.file) : null;
  const recording = !file && !endpointMs ? newVoiceNotePath() : null;
  const args = [
    ...(endpointMs ? ["--endpoint-ms", String(endpointMs)] : []),
    ...(file ? ["--file", file] : []),
    ...(recording ? ["--record", recording] : []),
  ];
  const note = file ?? recording;

  try {
    ensureBuilt();
  } catch {
    sendEnd(win, { code: 1, reason: "helper-build-failed" });
    return;
  }

  const sessionDir = mkdtempSync(path.join(app.getPath("temp"), "laterdog-speech-"));
  const outputPath = path.join(sessionDir, "stdout.ndjson");
  const errorPath = path.join(sessionDir, "stderr.log");
  const stopPath = path.join(sessionDir, "stop");
  const finishPath = path.join(sessionDir, "finish");
  writeFileSync(outputPath, "");
  writeFileSync(errorPath, "");

  let proc;
  try {
    proc = spawn(
      "/usr/bin/open",
      [
        "-n",
        "-g",
        "-W",
        "-o",
        outputPath,
        "--stderr",
        errorPath,
        BUNDLE,
        "--args",
        ...args,
        "--stop-file",
        stopPath,
        "--finish-file",
        finishPath,
      ],
      { stdio: "ignore" },
    );
  } catch {
    rmSync(sessionDir, { recursive: true, force: true });
    sendEnd(win, { code: 1, reason: "helper-start-failed" });
    return;
  }

  let settleClosed = () => {};
  const closed = new Promise((resolve) => {
    settleClosed = resolve;
  });
  const speechSession = { proc, outputPath, errorPath, stopPath, finishPath, sessionDir, closed };
  child = speechSession;
  let buf = "";
  let offset = 0;
  let reportedError = null;
  let completed = false;
  const transcript = speechTranscript();

  const drain = () => {
    let content;
    try {
      content = readFileSync(outputPath, "utf8");
    } catch {
      return;
    }
    if (content.length <= offset) return;
    buf += content.slice(offset);
    offset = content.length;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.error === "string") reportedError = parsed.error;
        if (parsed.partial === false && typeof parsed.text === "string") completed = true;
        const heard = transcript(parsed);
        if (child === speechSession && !win.isDestroyed()) {
          win.webContents.send("speech:transcript", heard);
        }
      } catch {}
    }
  };
  watchFile(outputPath, { interval: 50, persistent: false }, drain);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unwatchFile(outputPath, drain);
    rmSync(sessionDir, { recursive: true, force: true });
  };
  proc.on("close", (code) => {
    drain();
    cleanup();
    const kept = note && existsSync(note) ? { recording: note } : {};
    settleClosed(kept);
    if (child !== speechSession) return;
    child = null;
    if (reportedError) {
      sendEnd(win, { code: 1, reason: reportedError, ...kept });
    } else if (completed && code === 0) {
      sendEnd(win, { code: 0, reason: "completed", ...kept });
    } else {
      sendEnd(win, { code: 1, reason: "helper-exited", ...kept });
    }
  });
  proc.on("error", () => {
    cleanup();
    settleClosed({});
    if (child !== speechSession) return;
    child = null;
    sendEnd(win, { code: 1, reason: "helper-start-failed" });
  });
}

export function stopSpeech() {
  if (!child) return Promise.resolve({});
  const speechSession = child;
  child = null;
  try {
    writeFileSync(speechSession.stopPath, "stop");
  } catch {}
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), STOP_WAIT_MS);
    timer.unref?.();
    void speechSession.closed.then((kept) => {
      clearTimeout(timer);
      resolve(kept);
    });
  });
}

export async function voiceNoteAudio(file) {
  if (process.platform !== "darwin" || !isVoiceNote(file)) return null;
  const dir = mkdtempSync(path.join(app.getPath("temp"), "laterdog-voice-"));
  const out = path.join(dir, "voice-note.wav");
  try {
    const converted = await new Promise((resolve) => {
      const proc = spawn(
        "/usr/bin/afconvert",
        ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", path.resolve(file), out],
        { stdio: "ignore" },
      );
      const timer = setTimeout(() => proc.kill(), CONVERT_TIMEOUT_MS);
      proc.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    if (!converted) return null;
    const audio = readFileSync(out);
    return audio.byteLength > 44 ? audio : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function finishSpeech() {
  if (!child) return;
  try {
    writeFileSync(child.finishPath, "finish");
  } catch {}
}
