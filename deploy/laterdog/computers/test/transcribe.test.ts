import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { DAY } from "../src/trial";
import { TRANSCRIBE_MODEL, TRANSCRIBE_SECONDS_PER_DAY, base64, transcriptFrom, wavSeconds } from "../src/transcribe";
import { ORIGIN, body, siteverify, startTrial, trialKey, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Chunk = [string, Uint8Array];

const ascii = (text: string) => new TextEncoder().encode(text);

function riff(chunks: Chunk[]): Uint8Array {
  const parts: Uint8Array[] = [ascii("WAVE")];
  for (const [id, data] of chunks) {
    const head = new Uint8Array(8);
    head.set(ascii(id));
    new DataView(head.buffer).setUint32(4, data.byteLength, true);
    parts.push(head, data);
    if (data.byteLength % 2) parts.push(new Uint8Array(1));
  }
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(8 + size);
  out.set(ascii("RIFF"));
  new DataView(out.buffer).setUint32(4, size, true);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function fmt({ format = 1, channels = 1, rate = 16_000, bits = 16 } = {}): Chunk {
  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  view.setUint16(0, format, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, rate, true);
  view.setUint32(8, rate * channels * (bits / 8), true);
  view.setUint16(12, channels * (bits / 8), true);
  view.setUint16(14, bits, true);
  return ["fmt ", data];
}

const wav = (seconds: number, options: Parameters<typeof fmt>[0] = {}) =>
  riff([fmt(options), ["data", new Uint8Array(Math.round(seconds * (options.rate ?? 16_000)) * (options.channels ?? 1) * 2).fill(7)]]);

const whisperAnswer = { results: { channels: [{ alternatives: [{ transcript: " Hello from later.dog. ", confidence: 0.99 }], detected_language: "en", language_confidence: 0.98 }] } };

async function included() {
  const run = vi.fn(async () => whisperAnswer);
  const w = await world({ AI: { run, gateway: vi.fn() } } as unknown as Record<string, string>);
  siteverify();
  const key = trialKey("k");
  expect((await startTrial(w, key)).status).toBe(200);
  return { w, run, key };
}

function transcribe(key: string, fields: Record<string, string | Blob>, headers: Record<string, string> = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return new Request(`${ORIGIN}/v1/voice/speech-to-text`, { method: "POST", headers: { "xi-api-key": key, ...headers }, body: form });
}

const note = (audio: Uint8Array, type = "audio/wav") => new Blob([audio], { type });
const plainBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

describe("included transcription", () => {
  it("writes down a voice note with Nova-3 on Workers AI, straight to the model since the AI Gateway takes no audio streams", async () => {
    const { w, run, key } = await included();
    const audio = wav(1.5);
    const response = await w.fetch(transcribe(key, { model_id: "scribe_v2", file: note(audio), language_code: "en" }));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ language_code: "en", language_probability: 0.98, text: "Hello from later.dog.", words: [] });
    expect(run).toHaveBeenCalledWith(
      TRANSCRIBE_MODEL,
      { audio: { body: expect.any(ReadableStream), contentType: "audio/wav" }, smart_format: true, punctuate: true, language: "en" },
    );
    expect(run.mock.calls[0]).toHaveLength(2);
  });

  it("leaves the language to the model when none is named, or Nova-3 doesn't know it", async () => {
    const { w, run, key } = await included();
    expect((await w.fetch(transcribe(key, { file: note(wav(2)) }))).status).toBe(200);
    expect((await w.fetch(transcribe(key, { file: note(wav(2)), language_code: "" }))).status).toBe(200);
    expect((await w.fetch(transcribe(key, { file: note(wav(2)), language_code: "qq" }))).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(3);
    for (const [, input] of run.mock.calls as unknown as Array<[string, Record<string, unknown>]>) expect(input).not.toHaveProperty("language");
  });

  it("refuses anything but a short 16-bit WAV before any transcription", async () => {
    const { w, run, key } = await included();
    const refusals: Array<[Request, number, string]> = [
      [transcribe(key, { model_id: "scribe_v2" }), 422, "no_audio"],
      [transcribe(key, { file: "not a file" }), 422, "no_audio"],
      [transcribe(key, { file: note(ascii("ID3 mp3 bytes"), "audio/mpeg") }), 415, "unsupported_audio"],
      [transcribe(key, { file: note(wav(1, { bits: 8 })) }), 415, "unsupported_audio"],
      [transcribe(key, { file: note(wav(1, { format: 3, bits: 16 })) }), 415, "unsupported_audio"],
      [transcribe(key, { file: note(wav(0)) }), 422, "no_audio"],
      [transcribe(key, { file: note(wav(1_801, { rate: 8_000 })) }), 413, "too_long"],
      [transcribe(key, { file: note(wav(1)), language_code: "english" }), 422, "unsupported_language"],
      [new Request(`${ORIGIN}/v1/voice/speech-to-text`, { method: "POST", headers: { "xi-api-key": key, "content-type": "application/json" }, body: "{}" }), 415, "unsupported_media_type"],
      [new Request(`${ORIGIN}/v1/voice/speech-to-text`, { method: "POST", headers: { "xi-api-key": key, "content-type": "multipart/form-data; boundary=x" }, body: "nope" }), 400, "invalid_form"],
    ];
    for (const [request, status, code] of refusals) {
      const response = await w.fetch(request);
      expect(response.status, code).toBe(status);
      expect((await body(response)).error.code).toBe(code);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a body larger than thirty minutes of voice can be, without reading it all", async () => {
    const { w, run, key } = await included();
    const response = await w.fetch(transcribe(key, { file: note(new Uint8Array(61 * 1024 * 1024)) }));
    expect(response.status).toBe(413);
    expect((await body(response)).error.code).toBe("too_large");
    expect(run).not.toHaveBeenCalled();
  });

  it("serves only live free trials, never a browser, and stops when the trial window ends", async () => {
    const { w, run, key } = await included();
    expect((await w.fetch(transcribe(trialKey("z"), { file: note(wav(1)) }))).status).toBe(401);
    expect((await w.fetch(transcribe(key, { file: note(wav(1)) }, { origin: "https://evil.example" }))).status).toBe(403);
    await w.advance(8 * DAY);
    expect((await w.fetch(transcribe(key, { file: note(wav(1)) }))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("counts each started second of audio against the installation's day", async () => {
    const { w, run, key } = await included();
    expect((await w.fetch(transcribe(key, { file: note(wav(2.5)) }))).status).toBe(200);
    const registry = w.trials.named("trials");
    const keySha256 = await sha256Hex(key);
    expect(await registry.allowUsage({ keySha256, kind: "transcribe_seconds", amount: TRANSCRIBE_SECONDS_PER_DAY - 3, perKey: TRANSCRIBE_SECONDS_PER_DAY, total: 1_000_000 })).toEqual({ ok: true });
    const spent = await w.fetch(transcribe(key, { file: note(wav(1)) }));
    expect(spent.status).toBe(429);
    expect((await body(spent)).error.code).toBe("daily_limit");
    expect(run).toHaveBeenCalledTimes(1);
    await w.advance(DAY);
    expect((await w.fetch(transcribe(key, { file: note(wav(1)) }))).status).toBe(200);
  });

  it("says the service failed when Nova-3 throws or answers without text", async () => {
    const { w, run, key } = await included();
    run.mockRejectedValueOnce(new Error("3010: Invalid or incomplete input for the model"));
    expect((await w.fetch(transcribe(key, { file: note(wav(1)) }))).status).toBe(502);
    run.mockResolvedValueOnce({ segments: [] } as unknown as typeof whisperAnswer);
    expect((await w.fetch(transcribe(key, { file: note(wav(1)) }))).status).toBe(502);
  });
});

describe("how long a WAV recording is", () => {
  it("reads the length from the format and data chunks", () => {
    expect(wavSeconds(wav(1.5))).toBe(1.5);
    expect(wavSeconds(wav(2, { rate: 44_100, channels: 2 }))).toBe(2);
    expect(wavSeconds(riff([fmt(), ["LIST", ascii("INFOabc")], ["data", new Uint8Array(32_000)]]))).toBe(1);
    expect(wavSeconds(riff([fmt(), ["FLLR", new Uint8Array(4_044)], ["data", new Uint8Array(64_000)]]))).toBe(2);
    expect(wavSeconds(riff([fmt({ format: 0xfffe }), ["data", new Uint8Array(16_000)]]))).toBe(0.5);
  });

  it("counts only the audio that arrived when the data chunk claims more", () => {
    const whole = wav(2);
    expect(wavSeconds(whole.subarray(0, whole.byteLength - 16_000))).toBe(1.5);
  });

  it("is unknown for anything but 16-bit PCM in a RIFF WAVE file", () => {
    expect(wavSeconds(ascii("RIFF"))).toBeNull();
    expect(wavSeconds(ascii("ID3 mp3 bytes and more"))).toBeNull();
    expect(wavSeconds(riff([["data", new Uint8Array(32_000)], fmt()]))).toBeNull();
    expect(wavSeconds(riff([fmt()]))).toBeNull();
    expect(wavSeconds(wav(1, { channels: 6 }))).toBeNull();
    expect(wavSeconds(wav(1, { rate: 96_000 }))).toBeNull();
  });
});

describe("what Nova-3 answers", () => {
  it("reads the text with or without the result wrapper and keeps the detected language", () => {
    expect(transcriptFrom({ result: whisperAnswer })).toEqual({ language_code: "en", language_probability: 0.98, text: "Hello from later.dog.", words: [] });
    expect(transcriptFrom({ results: { channels: [{ alternatives: [{ transcript: "hola" }] }] } })).toEqual({ language_code: null, language_probability: null, text: "hola", words: [] });
    expect(transcriptFrom({ text: 3 })).toBeNull();
    expect(transcriptFrom("text")).toBeNull();
  });

  it("encodes large recordings in pieces", () => {
    const bytes = new Uint8Array(200_001).map((_, at) => at % 251);
    expect(base64(bytes)).toBe(plainBase64(bytes));
  });
});
