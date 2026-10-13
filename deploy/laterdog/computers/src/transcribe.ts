import type { Refusal } from "./auth";

export const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const TRANSCRIBE_MAX_SECONDS = 300;
export const TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024;
export const TRANSCRIBE_SECONDS_PER_DAY = 3_600;
export const TRANSCRIBE_SECONDS_TOTAL_PER_DAY = 360_000;

export type TranscriptionRequest = { audio: Uint8Array; seconds: number; language?: string };

export interface Transcript {
  language_code: string | null;
  language_probability: number | null;
  text: string;
  words: never[];
}

const LANGUAGE = /^[a-z]{2}$/;
const WHISPER_LANGUAGES = new Set(
  "af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo zh".split(" "),
);

const refuse = (status: number, code: string, message: string): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { status, code, message } });

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function wavSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let byteRate = 0;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const start = at + 8;
    if (id === "fmt ") {
      if (size < 16 || start + 16 > bytes.byteLength) return null;
      const format = view.getUint16(start, true);
      const channels = view.getUint16(start + 2, true);
      const rate = view.getUint32(start + 4, true);
      const bits = view.getUint16(start + 14, true);
      if ((format !== 1 && format !== 0xfffe) || bits !== 16 || channels < 1 || channels > 2 || rate < 8_000 || rate > 48_000) return null;
      byteRate = rate * channels * 2;
    } else if (id === "data") {
      return byteRate ? Math.min(size, bytes.byteLength - start) / byteRate : null;
    }
    at = start + size + (size % 2);
  }
  return null;
}

export async function transcriptionRequest(form: FormData): Promise<{ ok: true; request: TranscriptionRequest } | { ok: false; refusal: Refusal }> {
  const file = form.get("file");
  if (!file || typeof file === "string") return refuse(422, "no_audio", "Send the audio as a file named file.");
  const language = form.get("language_code");
  if (language !== null && (typeof language !== "string" || (language.trim() && !LANGUAGE.test(language.trim())))) {
    return refuse(422, "unsupported_language", "Name the language with a two-letter code, or leave it out.");
  }
  const audio = new Uint8Array(await file.arrayBuffer());
  const seconds = wavSeconds(audio);
  if (seconds === null) return refuse(415, "unsupported_audio", "Send 16-bit PCM WAV audio.");
  if (seconds <= 0) return refuse(422, "no_audio", "The recording is empty.");
  if (seconds > TRANSCRIBE_MAX_SECONDS) return refuse(413, "too_long", `Send at most ${TRANSCRIBE_MAX_SECONDS / 60} minutes of audio at a time.`);
  const code = typeof language === "string" ? language.trim() : "";
  return { ok: true, request: { audio, seconds, ...(code ? { language: code } : {}) } };
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.byteLength; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export function transcribeInput(request: TranscriptionRequest) {
  const language = request.language && WHISPER_LANGUAGES.has(request.language) ? { language: request.language } : {};
  return { audio: base64(request.audio), task: "transcribe", vad_filter: true, ...language };
}

export function transcriptFrom(raw: unknown): Transcript | null {
  if (!isRecord(raw)) return null;
  const result = isRecord(raw.result) ? raw.result : raw;
  if (typeof result.text !== "string") return null;
  const info = isRecord(result.transcription_info) ? result.transcription_info : {};
  return {
    language_code: typeof info.language === "string" ? info.language : null,
    language_probability: typeof info.language_probability === "number" ? info.language_probability : null,
    text: result.text.trim(),
    words: [],
  };
}
