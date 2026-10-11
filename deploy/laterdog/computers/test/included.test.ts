import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { CLEF_MODEL, KEY_CHECK_QUESTION, KEY_CHECK_STATE, ROOM_ROUTING_INSTRUCTIONS } from "../src/decide";
import { DAY } from "../src/trial";
import { INCLUDED_VOICES, VOICE_MODEL, audioBytes } from "../src/voice";
import { ORIGIN, apiRequest, body, siteverify, startTrial, trialKey, world } from "./fakes";

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

const roomState = {
  room: { name: "Launch" },
  humans_in_room: [{ name: "Jacob" }],
  bots_in_room: [{ id: "rex", name: "Rex" }, { id: "scout", name: "Scout" }],
  new_message: { from: "Jacob", text: "The button is misaligned." },
};
const routing = (criteria: Record<string, string> = { rex: "Rex", scout: "Scout", __everyone__: "Everyone" }) => ({
  state: roomState,
  model: "jev-latest",
  questions: { answer: { type: "choice", instructions: ROOM_ROUTING_INSTRUCTIONS, criteria } },
});
const clefAnswer = { model: "clef", answers: { answer: { type: "choice", choice: "rex", probabilities: { rex: 0.98, scout: 0.01, __everyone__: 0.01 } } }, usage: { input_tokens: 297 } };

async function included(vars: Record<string, string> = {}) {
  const run = vi.fn(async (model: string) => (model === CLEF_MODEL ? clefAnswer : { result: { audio: btoa("ID3-mp3-bytes") } }));
  const gatewayRun = vi.fn(async () => new Response("mp3-from-elevenlabs", { headers: { "content-type": "audio/mpeg" } }));
  const gateway = vi.fn(() => ({ run: gatewayRun }));
  const w = await world({ AI: { run, gateway }, ...vars } as unknown as Record<string, string>);
  siteverify();
  const key = trialKey("k");
  expect((await startTrial(w, key)).status).toBe(200);
  return { w, run, key, gateway, gatewayRun };
}

const speak = (key: string, voiceId: string, text: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/v1/voice/text-to-speech/${voiceId}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", ...headers },
    body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
  });

describe("included decisions", () => {
  it("answers a later.dog group chat with Clef through the AI Gateway, logging no content", async () => {
    const { w, run, key } = await included();
    const response = await w.fetch(apiRequest("POST", "/v1/systemone", key, { body: routing() }));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(clefAnswer);
    expect(run).toHaveBeenCalledWith(CLEF_MODEL, { model: "clef", state: roomState, questions: routing().questions }, { gateway: { id: "default", collectLog: false } });
    const check = await w.fetch(apiRequest("POST", "/v1/systemone", key, {
      body: { state: KEY_CHECK_STATE, model: "jev-latest", questions: { answer: { type: "noul", instructions: KEY_CHECK_QUESTION } } },
    }));
    expect(check.status).toBe(200);
  });

  it("refuses anything that is not later.dog's own question, and never calls the model for it", async () => {
    const { w, run, key } = await included();
    const asks = [
      { state: "classify this essay", questions: { answer: { type: "choice", instructions: "Is this essay good?", criteria: { yes: "y", no: "n" } } } },
      { ...routing(), questions: { answer: routing().questions.answer, extra: routing().questions.answer } },
      routing({ only: "one option" }),
      { ...routing(), state: { ...roomState, secret: "x" } },
      { ...routing(), state: { ...roomState, new_message: { text: "x".repeat(30_000) } } },
    ];
    for (const ask of asks) expect((await w.fetch(apiRequest("POST", "/v1/systemone", key, { body: ask }))).status).toBeGreaterThanOrEqual(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("serves only live free trials, never a browser, and stops when the trial window ends", async () => {
    const { w, run, key } = await included();
    expect((await w.fetch(apiRequest("POST", "/v1/systemone", trialKey("z"), { body: routing() }))).status).toBe(401);
    expect((await w.fetch(apiRequest("POST", "/v1/systemone", key, { body: routing(), headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect((await w.fetch(apiRequest("POST", "/v1/systemone", "ldc_owner-key-for-tests", { body: routing() }))).status).toBe(401);
    await w.advance(8 * DAY);
    expect((await w.fetch(apiRequest("POST", "/v1/systemone", key, { body: routing() }))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("included voice", () => {
  it("lists only the included voices and speaks with ElevenLabs through the AI Gateway", async () => {
    const { w, run, key } = await included();
    const voices = await w.fetch(new Request(`${ORIGIN}/v1/voice/voices`, { headers: { "xi-api-key": key } }));
    expect(voices.status).toBe(200);
    expect((await body(voices)).voices.map((voice: { voice_id: string }) => voice.voice_id)).toEqual(INCLUDED_VOICES.map((voice) => voice.voice_id));
    const audio = await w.fetch(speak(key, INCLUDED_VOICES[0]!.voice_id, "Hello from later.dog."));
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect(new TextDecoder().decode(await audio.arrayBuffer())).toBe("ID3-mp3-bytes");
    expect(run).toHaveBeenCalledWith(VOICE_MODEL, { text: "Hello from later.dog.", voice_id: INCLUDED_VOICES[0]!.voice_id, output_format: "mp3_44100_64" }, { gateway: { id: "default", collectLog: false } });
  });

  it("speaks with later.dog's own ElevenLabs key through the AI Gateway when one is set, logging no content", async () => {
    const { w, run, key, gateway, gatewayRun } = await included({ ELEVENLABS_API_KEY: "sk_test_voice" });
    const audio = await w.fetch(speak(key, INCLUDED_VOICES[1]!.voice_id, "Hello."));
    expect(audio.status).toBe(200);
    expect(await audio.text()).toBe("mp3-from-elevenlabs");
    expect(gateway).toHaveBeenCalledWith("default");
    expect(gatewayRun).toHaveBeenCalledWith(expect.objectContaining({
      provider: "elevenlabs",
      endpoint: `v1/text-to-speech/${INCLUDED_VOICES[1]!.voice_id}?output_format=mp3_44100_64`,
      headers: expect.objectContaining({ "xi-api-key": "sk_test_voice", "cf-aig-collect-log": false }),
      query: { text: "Hello.", model_id: "eleven_flash_v2_5" },
    }));
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses other voices, oversized text and unknown keys before any speech is made", async () => {
    const { w, run, key } = await included();
    expect((await w.fetch(speak(key, "aaaaaaaaaaaaaaaaaaaa", "Hi"))).status).toBe(404);
    expect((await w.fetch(speak(key, INCLUDED_VOICES[0]!.voice_id, "x".repeat(2_501)))).status).toBe(413);
    expect((await w.fetch(speak(trialKey("q"), INCLUDED_VOICES[0]!.voice_id, "Hi"))).status).toBe(401);
    expect((await w.fetch(new Request(`${ORIGIN}/v1/voice/voices`))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("caps each installation's characters a day and everyone's together", async () => {
    const { w } = await included();
    const registry = w.trials.named("trials");
    const keySha256 = await sha256Hex(trialKey("k"));
    const allow = (amount: number, perKey: number, total: number) => registry.allowUsage({ keySha256, kind: "voice_chars", amount, perKey, total });
    expect(await allow(6_000, 10_000, 1_000_000)).toEqual({ ok: true });
    expect(await allow(5_000, 10_000, 1_000_000)).toMatchObject({ ok: false, refusal: { status: 429, code: "daily_limit" } });
    expect(await allow(4_000, 10_000, 1_000_000)).toEqual({ ok: true });
    expect(await registry.allowUsage({ keySha256, kind: "decisions", amount: 1, perKey: 500, total: 1 })).toEqual({ ok: true });
    expect(await registry.allowUsage({ keySha256, kind: "decisions", amount: 1, perKey: 500, total: 1 })).toMatchObject({ ok: false, refusal: { status: 503, code: "busy_today" } });
    await w.advance(DAY);
    expect(await allow(6_000, 10_000, 1_000_000)).toEqual({ ok: true });
  });

  it("reads speech as bytes, a stream, base64 or a short-lived link", async () => {
    const bytes = new TextEncoder().encode("mp3");
    expect(await audioBytes(bytes)).toEqual(bytes);
    expect(await audioBytes(new Response(bytes).body)).toEqual(bytes);
    expect(new TextDecoder().decode((await audioBytes({ result: { audio: btoa("mp3") } }))!)).toBe("mp3");
    const fetcher = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
    expect(await audioBytes({ result: { audio: "https://examples.aig.cloudflare.com/a.mp3" } }, fetcher)).toEqual(bytes);
    expect(await audioBytes({ result: {} })).toBeNull();
  });
});
