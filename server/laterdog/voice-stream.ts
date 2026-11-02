import { transcribeAudio } from "./transcribe.ts";
import { isXaiVoice, transcribeWithXai, type Transcriber } from "./transcribe-xai.ts";

export const STREAM_RATE = 16_000;
export const STREAM_MAX_SECONDS = 600;
export const STREAM_IDLE_MS = 120_000;
export const STREAM_SESSIONS = 8;

const FRAME = STREAM_RATE / 50;
const FIRST_CUT = 2 * STREAM_RATE;
const LONGEST_PIECE = 15 * STREAM_RATE;
const QUIET_FRAMES = 18;
const QUIET_FLOOR = 250;
const SHORTEST_TAIL = STREAM_RATE / 5;

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
  1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const INDEX_SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8];

export interface AdpcmState {
  predictor: number;
  index: number;
}

export const freshAdpcm = (): AdpcmState => ({ predictor: 0, index: 0 });

export function decodeAdpcm(bytes: Uint8Array, state: AdpcmState): Int16Array {
  const out = new Int16Array(bytes.byteLength * 2);
  let { predictor, index } = state;
  for (let at = 0; at < out.length; at++) {
    const byte = bytes[at >> 1]!;
    const nibble = at & 1 ? byte >> 4 : byte & 15;
    const step = STEPS[index]!;
    let diff = step >> 3;
    if (nibble & 4) diff += step;
    if (nibble & 2) diff += step >> 1;
    if (nibble & 1) diff += step >> 2;
    predictor += nibble & 8 ? -diff : diff;
    predictor = Math.max(-32768, Math.min(32767, predictor));
    index = Math.max(0, Math.min(88, index + INDEX_SHIFT[nibble & 7]!));
    out[at] = predictor;
  }
  state.predictor = predictor;
  state.index = index;
  return out;
}

export function wavFrom(pcm: Int16Array, rate = STREAM_RATE): Uint8Array {
  const data = pcm.byteLength;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const text = (at: number, word: string) => { for (let i = 0; i < 4; i++) out[at + i] = word.charCodeAt(i); };
  text(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, data, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, data), 44);
  return out;
}

function frameLevel(pcm: Int16Array, start: number): number {
  let sum = 0;
  for (let at = start; at < start + FRAME; at++) sum += Math.abs(pcm[at]!);
  return sum / FRAME;
}

export function nextCut(pcm: Int16Array, from: number, to: number): number | null {
  if (to - from < FIRST_CUT + QUIET_FRAMES * FRAME) return null;
  const frames: number[] = [];
  for (let start = from; start + FRAME <= to; start += FRAME) frames.push(frameLevel(pcm, start));
  const sorted = [...frames].sort((a, b) => a - b);
  const quiet = Math.max(QUIET_FLOOR, sorted[Math.floor(sorted.length / 2)]! * 0.25);
  let run = 0;
  for (let frame = FIRST_CUT / FRAME; frame < frames.length; frame++) {
    run = frames[frame]! < quiet ? run + 1 : 0;
    if (run === QUIET_FRAMES) return from + (frame - QUIET_FRAMES / 2) * FRAME;
  }
  if (to - from < LONGEST_PIECE) return null;
  let best = FIRST_CUT / FRAME;
  for (let frame = best; frame < LONGEST_PIECE / FRAME; frame++) if (frames[frame]! < frames[best]!) best = frame;
  return from + best * FRAME;
}

export function joinPieces(words: readonly string[]): string {
  const parts = words.map((word) => word.trim()).filter(Boolean);
  return parts.map((part, at) => {
    const next = parts[at + 1];
    return next && /[\p{L}\p{N}]$/u.test(part) && /^\p{Lu}/u.test(next) ? `${part}.` : part;
  }).join(" ");
}

export type Transcribe = (wav: Uint8Array, language?: string) => Promise<string>;

export function serviceTranscriber(service: Transcriber, fetcher: typeof fetch = fetch): Transcribe {
  return async (wav, language) => {
    const heard = isXaiVoice(service)
      ? await transcribeWithXai(wav, service, language, fetcher)
      : await transcribeAudio(wav, service, language, fetcher);
    return heard.text;
  };
}

export interface StreamTimings {
  pieces: number;
  waitMs: number;
  tailMs: number;
}

export type StreamAnswer =
  | { ok: true; done: false }
  | { ok: true; done: true; text: string; timings: StreamTimings }
  | { ok: false; status: number; error: string };

interface Piece {
  heard: Promise<string>;
  ms: number | null;
}

interface Session {
  pcm: Int16Array;
  length: number;
  cut: number;
  seq: number;
  adpcm: AdpcmState;
  pieces: Piece[];
  language?: string;
  touched: number;
  transcribe: Transcribe;
}

function grow(session: Session, more: Int16Array): void {
  if (session.length + more.length > session.pcm.length) {
    const bigger = new Int16Array(Math.max(session.pcm.length * 2, session.length + more.length));
    bigger.set(session.pcm.subarray(0, session.length));
    session.pcm = bigger;
  }
  session.pcm.set(more, session.length);
  session.length += more.length;
}

function send(session: Session, end: number, now: () => number): void {
  const pcm = session.pcm.slice(session.cut, end);
  session.cut = end;
  const started = now();
  const piece: Piece = { heard: Promise.resolve(""), ms: null };
  piece.heard = session.transcribe(wavFrom(pcm), session.language).finally(() => { piece.ms = Math.round(now() - started); });
  piece.heard.catch(() => undefined);
  session.pieces.push(piece);
}

export function createVoiceStreams(now: () => number = () => performance.now()) {
  const sessions = new Map<string, Session>();

  const sweep = () => {
    for (const [id, session] of sessions) if (now() - session.touched > STREAM_IDLE_MS) sessions.delete(id);
  };

  return {
    size: () => sessions.size,
    drop(id: string): void {
      sessions.delete(id);
    },
    async add(id: string, seq: number, bytes: Uint8Array, final: boolean, transcribe: Transcribe, language?: string): Promise<StreamAnswer> {
      sweep();
      let session = sessions.get(id);
      if (!session) {
        if (seq !== 0) return { ok: false, status: 409, error: "That dictation is no longer on the home. Send it again." };
        if (sessions.size >= STREAM_SESSIONS) return { ok: false, status: 429, error: "Too many dictations at once." };
        session = { pcm: new Int16Array(STREAM_RATE * 4), length: 0, cut: 0, seq: -1, adpcm: freshAdpcm(), pieces: [], touched: now(), transcribe, ...(language ? { language } : {}) };
        sessions.set(id, session);
      }
      session.touched = now();
      if (seq === session.seq && !final) return { ok: true, done: false };
      if (seq !== session.seq + 1) return { ok: false, status: 409, error: "Parts of that dictation arrived out of order." };
      session.seq = seq;
      grow(session, decodeAdpcm(bytes, session.adpcm));
      if (session.length > STREAM_MAX_SECONDS * STREAM_RATE) {
        sessions.delete(id);
        return { ok: false, status: 413, error: "That voice note is too long to transcribe." };
      }
      for (let cut = nextCut(session.pcm, session.cut, session.length); cut !== null; cut = nextCut(session.pcm, session.cut, session.length)) send(session, cut, now);
      if (!final) return { ok: true, done: false };
      const waitStarted = now();
      if (session.length - session.cut >= SHORTEST_TAIL || session.pieces.length === 0) send(session, session.length, now);
      sessions.delete(id);
      try {
        const words = await Promise.all(session.pieces.map((piece) => piece.heard));
        const text = joinPieces(words);
        const tail = session.pieces.at(-1)?.ms ?? 0;
        return { ok: true, done: true, text, timings: { pieces: session.pieces.length, waitMs: Math.round(now() - waitStarted), tailMs: tail } };
      } catch (error) {
        return { ok: false, status: 502, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
