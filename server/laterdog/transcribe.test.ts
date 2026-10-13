import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TRANSCRIBE_MAX_BYTES, TRANSCRIBE_MODEL, readAudio, transcribeAudio, transcribeRoute } from "./transcribe.ts";

const OWN = { token: "sk_own_voice", api: "https://elevenlabs.example/v1", included: false };
const TRIAL = { token: `ldt_${"k".repeat(43)}`, api: "https://computers.example/v1/voice", included: true };
const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

function request(body: Uint8Array | Uint8Array[], headers: Record<string, string> = { "content-type": "audio/wav" }): IncomingMessage {
  const chunks = Array.isArray(body) ? body : [body];
  const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  return Object.assign(stream, { headers }) as unknown as IncomingMessage;
}

const at = (query = "") => new URL(`http://localhost/api/voice/transcribe${query}`);

function answering(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(body, { status }));
}

const sent = (fetcher: ReturnType<typeof answering>) => {
  const [url, init] = fetcher.mock.calls[0]!;
  return { url: String(url), init: init!, form: init!.body as FormData };
};

describe("transcribing a voice note", () => {
  it("sends the recording to ElevenLabs Scribe with the person's own key and the language hint", async () => {
    const fetcher = answering(200, { language_code: "eng", language_probability: 0.99, text: " Book the table for six. ", words: [] });
    const answer = await transcribeRoute(request(WAV), at("?language=EN"), true, OWN, fetcher);
    expect(answer).toEqual({ status: 200, body: { text: "Book the table for six.", language: "eng", included: false } });
    const { url, init, form } = sent(fetcher);
    expect(url).toBe("https://elevenlabs.example/v1/speech-to-text");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "xi-api-key": "sk_own_voice" });
    expect(form.get("model_id")).toBe(TRANSCRIBE_MODEL);
    expect(form.get("language_code")).toBe("en");
    expect(form.get("tag_audio_events")).toBe("false");
    const file = form.get("file") as File;
    expect(file.name).toBe("voice-note.wav");
    expect(file.type).toBe("audio/wav");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(WAV);
  });

  it("uses the free trial's included transcription the same way, and leaves the language to the service when none is given", async () => {
    const fetcher = answering(200, { language_code: "es", language_probability: 0.9, text: "hola", words: [] });
    const answer = await transcribeRoute(request([WAV.subarray(0, 3), WAV.subarray(3)]), at(), true, TRIAL, fetcher);
    expect(answer).toEqual({ status: 200, body: { text: "hola", language: "es", included: true } });
    const { url, init, form } = sent(fetcher);
    expect(url).toBe("https://computers.example/v1/voice/speech-to-text");
    expect(init.headers).toEqual({ "xi-api-key": TRIAL.token });
    expect(form.has("language_code")).toBe(false);
    expect(new Uint8Array(await (form.get("file") as File).arrayBuffer())).toEqual(WAV);
  });

  it("does nothing when it is switched off or there is no service, and says which", async () => {
    const fetcher = answering(200, { text: "x" });
    expect(await transcribeRoute(request(WAV), at(), false, OWN, fetcher)).toMatchObject({ status: 409, body: { reason: "off" } });
    expect(await transcribeRoute(request(WAV), at(), true, null, fetcher)).toMatchObject({ status: 409, body: { reason: "no-service" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a WAV voice note of a sensible size before sending it anywhere", async () => {
    const fetcher = answering(200, { text: "x" });
    expect((await transcribeRoute(request(WAV, {}), at(), true, OWN, fetcher)).status).toBe(415);
    expect((await transcribeRoute(request(WAV, { "content-type": "audio/mpeg" }), at(), true, OWN, fetcher)).status).toBe(415);
    expect((await transcribeRoute(request(WAV, { "content-type": "audio/wav", "content-length": String(TRANSCRIBE_MAX_BYTES + 1) }), at(), true, OWN, fetcher)).status).toBe(413);
    expect((await transcribeRoute(request(WAV), at("?language=english"), true, OWN, fetcher)).status).toBe(400);
    expect((await transcribeRoute(request(new Uint8Array(0)), at(), true, OWN, fetcher)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stops reading a recording that grows past the limit without a declared length", async () => {
    const piece = new Uint8Array(1024 * 1024);
    const pieces = Array.from({ length: 11 }, () => piece);
    expect(await readAudio(request(pieces))).toBe("too-large");
    expect(await readAudio(request(pieces), 12 * 1024 * 1024)).toHaveLength(11 * 1024 * 1024);
  });

  it("explains a refused own key, and passes on what the included service says", async () => {
    const refused = await transcribeRoute(request(WAV), at(), true, OWN, answering(401, { detail: { status: "missing_permissions", message: "The API key you used is missing the permission speech_to_text" } }));
    expect(refused.status).toBe(502);
    expect(refused.body.error).toMatch(/Speech to Text permission/);
    const limited = await transcribeRoute(request(WAV), at(), true, TRIAL, answering(429, { error: { code: "daily_limit", message: "This installation has used today's allowance. It resets at midnight UTC." } }));
    expect(limited).toEqual({ status: 502, body: { error: "This installation has used today's allowance. It resets at midnight UTC." } });
    const silent = await transcribeRoute(request(WAV), at(), true, OWN, answering(200, { words: [] }));
    expect(silent).toEqual({ status: 502, body: { error: "The transcription came back without text." } });
  });

  it("says when the service can't be reached", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(transcribeAudio(WAV, OWN, undefined, offline)).rejects.toThrow("Couldn't reach ElevenLabs to transcribe. Check your connection.");
    await expect(transcribeAudio(WAV, TRIAL, undefined, offline)).rejects.toThrow("Couldn't reach the included transcription.");
  });
});
