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
const SIGNATURES = { png: "\x89PNG\r\n\x1a\n", jpeg: "\xff\xd8\xff\xe0", webp: "RIFF\0\0\0\0WEBPVP8 " } as const;
const dataUrl = (type: keyof typeof SIGNATURES, tail = "pixels") => `data:image/${type};base64,${btoa(SIGNATURES[type] + tail)}`;
const clefAnswer = { model: "clef", answers: { answer: { type: "choice", choice: "rex", probabilities: { rex: 0.98, scout: 0.01, __everyone__: 0.01 } } }, usage: { input_tokens: 297 } };

async function included(vars: Record<string, string> = {}, elevenLabs: "ok" | "down" = "ok") {
  const run = vi.fn(async (model: string) => (model === CLEF_MODEL ? clefAnswer : new Response("ID3-mp3-bytes").body));
  const gatewayRun = vi.fn(async () => elevenLabs === "down"
    ? new Response("{\"detail\":{\"status\":\"quota_exceeded\"}}", { status: 401 })
    : new Response("mp3-from-elevenlabs", { headers: { "content-type": "audio/mpeg" } }));
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

describe("what the trial says is included", () => {
  it("names only the services that are set up", async () => {
    const { w, key } = await included();
    expect((await body(await w.fetch(new Request(`${ORIGIN}/v1/trials`)))).included).toEqual(["decisions", "voice", "ai"]);
    expect((await body(await w.fetch(apiRequest("GET", "/v1/trial", key)))).included).toEqual(["decisions", "voice", "ai"]);
    const all = await included({ ELEVENLABS_API_KEY: "sk", XAI_API_KEY: "xai" });
    expect((await body(await all.w.fetch(apiRequest("GET", "/v1/trial", all.key)))).included).toEqual(["decisions", "voice", "ai"]);
  });
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

  it("passes up to four images and a chosen Clef model on to the model", async () => {
    const { w, run, key } = await included();
    const photos = [dataUrl("png"), dataUrl("jpeg"), dataUrl("webp")];
    for (const [selector, id] of [["clef-flash", "@cf/cloudflare/clef-flash"], ["clef-omni", "@cf/cloudflare/clef-omni"], ["clef", CLEF_MODEL]] as const) {
      run.mockClear();
      const response = await w.fetch(apiRequest("POST", "/v1/systemone", key, { body: { ...routing(), model: selector, images: photos } }));
      expect(response.status).toBe(200);
      expect(run).toHaveBeenCalledWith(id, { model: selector, state: roomState, questions: routing().questions, images: photos }, { gateway: { id: "default", collectLog: false } });
    }
    run.mockClear();
    expect((await w.fetch(apiRequest("POST", "/v1/systemone", key, { body: { ...routing(), model: "gpt-9" } }))).status).toBe(200);
    expect(run).toHaveBeenCalledWith(CLEF_MODEL, { model: "clef", state: roomState, questions: routing().questions }, { gateway: { id: "default", collectLog: false } });
  });

  it("refuses unusable images before any model is called", async () => {
    const { w, run, key } = await included();
    const send = (images: unknown, extra: Record<string, unknown> = {}) => w.fetch(apiRequest("POST", "/v1/systemone", key, { body: { ...routing(), images, ...extra } }));
    expect((await send([dataUrl("png"), dataUrl("png"), dataUrl("png"), dataUrl("png"), dataUrl("png")])).status).toBe(422);
    expect((await send("not-an-array")).status).toBe(422);
    expect((await send([42])).status).toBe(422);
    expect((await send(["https://example.com/a.png"])).status).toBe(422);
    expect((await send([`data:image/gif;base64,${btoa("GIF89a")}`])).status).toBe(422);
    expect((await send([`data:image/png;base64,${btoa(SIGNATURES.jpeg + "pixels")}`])).status).toBe(422);
    const big = await send([dataUrl("jpeg", "x".repeat(150_000))]);
    expect(big.status).toBe(413);
    expect(await body(big)).toMatchObject({ error: { code: "too_large" } });
    const together = Array.from({ length: 4 }, () => dataUrl("jpeg", "x".repeat(100_000)));
    const overBody = await send(together);
    expect(overBody.status).toBe(413);
    expect(await body(overBody)).toMatchObject({ error: { code: "too_large" } });
    expect((await w.fetch(apiRequest("POST", "/v1/systemone", key, {
      body: { state: KEY_CHECK_STATE, images: [dataUrl("png")], questions: { answer: { type: "noul", instructions: KEY_CHECK_QUESTION } } },
    }))).status).toBe(422);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the old body cap for text-only decisions", async () => {
    const { w, run, key } = await included();
    const response = await w.fetch(apiRequest("POST", "/v1/systemone", key, { body: { ...routing(), padding: "x".repeat(70_000) } }));
    expect(response.status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });

  it("counts image calls in the same daily decision limits", async () => {
    const { w, key } = await included();
    expect((await w.fetch(apiRequest("POST", "/v1/systemone", key, { body: { ...routing(), images: [dataUrl("png")] } }))).status).toBe(200);
    const registry = w.trials.named("trials");
    const keySha256 = await sha256Hex(key);
    expect(await registry.allowUsage({ keySha256, kind: "decisions", amount: 1, perKey: 1, total: 100 })).toMatchObject({ ok: false, refusal: { status: 429, code: "daily_limit" } });
    expect(await registry.allowUsage({ keySha256, kind: "decisions", amount: 1, perKey: 2, total: 1 })).toMatchObject({ ok: false, refusal: { status: 503, code: "busy_today" } });
    expect(await registry.allowUsage({ keySha256, kind: "decisions", amount: 1, perKey: 2, total: 2 })).toEqual({ ok: true });
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
  it("lists only the included voices and speaks with Cloudflare's Aura voices when no ElevenLabs key is set", async () => {
    const { w, run, key, gatewayRun } = await included();
    const voices = await w.fetch(new Request(`${ORIGIN}/v1/voice/voices`, { headers: { "xi-api-key": key } }));
    expect(voices.status).toBe(200);
    const listed = (await body(voices)).voices as Array<{ voice_id: string; name: string; labels: { accent: string } }>;
    expect(listed.map((voice) => voice.voice_id)).toEqual(INCLUDED_VOICES.map((voice) => voice.voice_id));
    expect(listed[0]).toMatchObject({ name: "George", labels: { accent: "British", description: "warm" } });
    expect(listed[3]).toMatchObject({ name: "Charlie", labels: { accent: "Australian" } });
    const audio = await w.fetch(speak(key, INCLUDED_VOICES[0]!.voice_id, "Hello from later.dog."));
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect(new TextDecoder().decode(await audio.arrayBuffer())).toBe("ID3-mp3-bytes");
    expect(run).toHaveBeenCalledWith(VOICE_MODEL, { text: "Hello from later.dog.", speaker: "draco", encoding: "mp3" }, { gateway: { id: "default", collectLog: false } });
    expect(gatewayRun).not.toHaveBeenCalled();
  });

  it("falls back to the Aura voices when ElevenLabs refuses", async () => {
    const { w, run, key, gatewayRun } = await included({ ELEVENLABS_API_KEY: "sk_test_voice" }, "down");
    const audio = await w.fetch(speak(key, INCLUDED_VOICES[7]!.voice_id, "Hello."));
    expect(audio.status).toBe(200);
    expect(new TextDecoder().decode(await audio.arrayBuffer())).toBe("ID3-mp3-bytes");
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(VOICE_MODEL, { text: "Hello.", speaker: "zeus", encoding: "mp3" }, { gateway: { id: "default", collectLog: false } });
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
    const voices = await w.fetch(new Request(`${ORIGIN}/v1/voice/voices`, { headers: { "xi-api-key": key } }));
    expect((await body(voices)).voices).toEqual(INCLUDED_VOICES);
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
