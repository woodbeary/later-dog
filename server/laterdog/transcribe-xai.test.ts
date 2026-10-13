import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { transcribeRoute } from "./transcribe.ts";
import { XAI_API_DEFAULT, pickTranscriber, transcribeWithXai, xaiVoice } from "./transcribe-xai.ts";

const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const OWN_ELEVENLABS = { token: "sk_own_voice", api: "https://elevenlabs.example/v1", included: false };
const TRIAL = { token: `ldt_${"k".repeat(43)}`, api: "https://computers.example/v1/voice", included: true };
const GROK = xaiVoice(" xai-own-key ", "https://xai.example/v1/")!;

function request(body: Uint8Array): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), { headers: { "content-type": "audio/wav" } }) as unknown as IncomingMessage;
}

const at = (query = "") => new URL(`http://localhost/api/voice/transcribe${query}`);

function answering(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(body, { status }));
}

describe("transcribing a voice note with the person's xAI key", () => {
  it("sends the recording to xAI speech to text with the key as a bearer token and the file last", async () => {
    const fetcher = answering(200, { text: " Remind me at nine. ", language: "en", duration: 1.5, words: [] });
    const answer = await transcribeRoute(request(WAV), at("?language=en"), true, GROK, fetcher);
    expect(answer).toEqual({ status: 200, body: { text: "Remind me at nine.", language: "en", included: false } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://xai.example/v1/stt");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toEqual({ authorization: "Bearer xai-own-key" });
    const form = init!.body as FormData;
    expect([...form.keys()]).toEqual(["language", "file"]);
    expect(form.get("language")).toBe("en");
    const file = form.get("file") as File;
    expect(file.name).toBe("voice-note.wav");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(WAV);
  });

  it("explains a refused key, passes on what xAI says otherwise, and says when it can't be reached", async () => {
    const refused = await transcribeRoute(request(WAV), at(), true, GROK, answering(401, { code: "unauthorized", error: "Incorrect API key provided" }));
    expect(refused).toEqual({ status: 502, body: { error: "xAI refused this key for speech to text. Check the xAI key in Settings." } });
    const busy = await transcribeRoute(request(WAV), at(), true, GROK, answering(503, { error: "Backend unavailable" }));
    expect(busy).toEqual({ status: 502, body: { error: "Transcription failed: Backend unavailable" } });
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(transcribeWithXai(WAV, GROK, undefined, offline)).rejects.toThrow("Couldn't reach xAI to transcribe. Check your connection.");
  });

  it("prefers the person's own ElevenLabs key, then their xAI key, then the included service", () => {
    expect(xaiVoice("   ")).toBeNull();
    expect(xaiVoice("key")?.api).toBe(XAI_API_DEFAULT);
    expect(pickTranscriber(OWN_ELEVENLABS, GROK)).toBe(OWN_ELEVENLABS);
    expect(pickTranscriber(TRIAL, GROK)).toBe(GROK);
    expect(pickTranscriber(null, GROK)).toBe(GROK);
    expect(pickTranscriber(TRIAL, null)).toBe(TRIAL);
    expect(pickTranscriber(null, null)).toBeNull();
  });
});
