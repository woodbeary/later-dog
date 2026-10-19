import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { SPEECH_CACHE_PATH, SpeechCache, speechDigest } from "../src/speech-cache";
import { INCLUDED_VOICES, VOICE_MODEL, elevenLabsRequest, elevenLabsVoice } from "../src/voice";
import { ORIGIN, body, siteverify, startTrial, trialKey, viaGateway, world } from "./fakes";

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

const BYOK = { ELEVENLABS_MODE: "byok", ELEVENLABS_CHARS_PER_DAY: "1000" };

function edgeCache(broken = false) {
  const entries = new Map<string, Uint8Array>();
  const store = {
    match: vi.fn(async (request: Request) => {
      if (broken) throw new Error("cache unavailable");
      const bytes = entries.get(request.url);
      return bytes ? new Response(bytes, { headers: { "content-type": "audio/mpeg" } }) : undefined;
    }),
    put: vi.fn(async (request: Request, response: Response) => {
      if (broken) throw new Error("cache unavailable");
      entries.set(request.url, new Uint8Array(await response.arrayBuffer()));
    }),
  };
  vi.stubGlobal("caches", { default: store });
  return { store, entries };
}

async function voiced(vars: Record<string, string> = {}, elevenLabs: "ok" | "down" = "ok") {
  const run = vi.fn(async () => new Response("aura-mp3").body);
  const gatewayRun = vi.fn(async () => elevenLabs === "down"
    ? new Response("{\"detail\":{\"status\":\"quota_exceeded\"}}", { status: 401 })
    : new Response("elevenlabs-mp3", { headers: { "content-type": "audio/mpeg" } }));
  const gateway = vi.fn(() => ({ run: gatewayRun }));
  const w = await world({ AI: { run, gateway }, ...vars } as unknown as Record<string, string>);
  siteverify();
  const key = trialKey("v");
  expect((await startTrial(w, key)).status).toBe(200);
  return { w, run, gateway, gatewayRun, key };
}

const voice = INCLUDED_VOICES[1]!;

const speak = (key: string, text: string, voiceId = voice.voice_id) =>
  new Request(`${ORIGIN}/v1/voice/text-to-speech/${voiceId}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

async function spoken(response: Response) {
  return { status: response.status, engine: response.headers.get("x-speech-engine"), cache: response.headers.get("x-speech-cache"), audio: await response.text() };
}

describe("spending ElevenLabs credits on purpose", () => {
  it("stays on Aura while ELEVENLABS_MODE is off, even with a key set", async () => {
    const switchedOff: Array<Record<string, string>> = [{ ELEVENLABS_API_KEY: "sk_test_voice" }, { ELEVENLABS_API_KEY: "sk_test_voice", ELEVENLABS_CHARS_PER_DAY: "1000" }, { ELEVENLABS_MODE: "secret", ELEVENLABS_CHARS_PER_DAY: "1000" }, { ELEVENLABS_MODE: "byok" }, { ELEVENLABS_MODE: "byok", ELEVENLABS_CHARS_PER_DAY: "0" }];
    for (const vars of switchedOff) {
      const { w, run, gatewayRun, key } = await voiced(vars);
      expect(await spoken(await w.fetch(speak(key, "Hello.")))).toEqual({ status: 200, engine: "aura", cache: "miss", audio: "aura-mp3" });
      expect(gatewayRun, JSON.stringify(vars)).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(1);
      const voices = (await body(await w.fetch(new Request(`${ORIGIN}/v1/voice/voices`, { headers: { "xi-api-key": key } })))).voices;
      expect(voices[1].labels.description).toBe("calm");
      vi.restoreAllMocks();
    }
  });

  it("lets the AI Gateway supply the key in byok mode, and tags the call with the key's user and tier", async () => {
    const { w, run, gateway, gatewayRun, key } = await voiced(BYOK);
    expect(await spoken(await w.fetch(speak(key, "Hello.")))).toEqual({ status: 200, engine: "elevenlabs", cache: "miss", audio: "elevenlabs-mp3" });
    expect(run).not.toHaveBeenCalled();
    expect(gateway).toHaveBeenCalledWith("default");
    const sent = (gatewayRun.mock.calls as unknown as Array<[{ provider: string; headers: Record<string, unknown> }]>)[0]![0];
    expect(sent.provider).toBe("elevenlabs");
    expect(sent.headers).not.toHaveProperty("xi-api-key");
    expect(JSON.parse(String(sent.headers["cf-aig-metadata"]))).toEqual((await viaGateway(key)).gateway.metadata);
    expect(sent.headers["cf-aig-collect-log"]).toBe(false);
    const voices = (await body(await w.fetch(new Request(`${ORIGIN}/v1/voice/voices`, { headers: { "xi-api-key": key } })))).voices;
    expect(voices).toEqual(INCLUDED_VOICES);
  });

  it("falls back to Aura once today's ElevenLabs characters are used, for everyone together", async () => {
    const { w, run, gatewayRun, key } = await voiced({ ELEVENLABS_MODE: "byok", ELEVENLABS_CHARS_PER_DAY: "10" });
    expect((await spoken(await w.fetch(speak(key, "Hello.")))).engine).toBe("elevenlabs");
    const second = await spoken(await w.fetch(speak(key, "Again.")));
    expect(second).toEqual({ status: 200, engine: "aura", cache: "miss", audio: "aura-mp3" });
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(VOICE_MODEL, { text: "Again.", speaker: "athena", encoding: "mp3" }, await viaGateway(key));
    const other = trialKey("w");
    expect((await startTrial(w, other, "198.51.100.9")).status).toBe(200);
    expect((await spoken(await w.fetch(speak(other, "Hello.")))).engine).toBe("aura");
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    await w.advance(24 * 60 * 60 * 1000);
    expect((await spoken(await w.fetch(speak(key, "Hello.")))).engine).toBe("elevenlabs");
  });

  it("gives the characters back when ElevenLabs refuses, so a failure costs no budget", async () => {
    const { w, run, gatewayRun, key } = await voiced({ ELEVENLABS_MODE: "byok", ELEVENLABS_CHARS_PER_DAY: "6" }, "down");
    expect((await spoken(await w.fetch(speak(key, "Hello.")))).engine).toBe("aura");
    expect((await spoken(await w.fetch(speak(key, "Hello.")))).engine).toBe("aura");
    expect(gatewayRun).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps ElevenLabs to the tiers ELEVENLABS_TIERS names", async () => {
    const plans = await voiced({ ...BYOK, ELEVENLABS_TIERS: "plan" });
    expect((await spoken(await plans.w.fetch(speak(plans.key, "Hello.")))).engine).toBe("aura");
    expect(plans.gatewayRun).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const trials = await voiced({ ...BYOK, ELEVENLABS_TIERS: "plan, trial" });
    expect((await spoken(await trials.w.fetch(speak(trials.key, "Hello.")))).engine).toBe("elevenlabs");
  });

  it("uses the Worker's own key only in secret mode", () => {
    const env = (vars: Record<string, string>) => vars as unknown as Env;
    expect(elevenLabsVoice(env({ ELEVENLABS_MODE: "secret", ELEVENLABS_API_KEY: " sk ", ELEVENLABS_CHARS_PER_DAY: "500" }))).toEqual({ key: "sk", charsPerDay: 500, tiers: ["trial", "home", "plan"] });
    expect(elevenLabsVoice(env({ ELEVENLABS_MODE: "byok", ELEVENLABS_API_KEY: "sk", ELEVENLABS_CHARS_PER_DAY: "500", ELEVENLABS_TIERS: "home,nobody" }))).toEqual({ charsPerDay: 500, tiers: ["home"] });
    expect(elevenLabsVoice(env({ ELEVENLABS_MODE: "off", ELEVENLABS_API_KEY: "sk", ELEVENLABS_CHARS_PER_DAY: "500" }))).toBeNull();
    expect(elevenLabsVoice(env({ ELEVENLABS_MODE: "byok", ELEVENLABS_CHARS_PER_DAY: "lots" }))).toBeNull();
    const request = { voiceId: voice.voice_id, text: "Hi", outputFormat: "mp3_44100_64" };
    expect(elevenLabsRequest(request, "sk").headers).toHaveProperty("xi-api-key", "sk");
    expect(elevenLabsRequest(request).headers).not.toHaveProperty("xi-api-key");
  });
});

describe("the speech cache", () => {
  it("answers repeated Aura speech from the cache with no model call", async () => {
    const { entries, store } = edgeCache();
    const { w, run, key } = await voiced();
    expect(await spoken(await w.fetch(speak(key, "Good morning.")))).toEqual({ status: 200, engine: "aura", cache: "miss", audio: "aura-mp3" });
    await Promise.all(w.background);
    expect(entries.size).toBe(1);
    const [address] = [...entries.keys()];
    expect(address).toBe(new URL(`${SPEECH_CACHE_PATH}${await speechDigest({ engine: VOICE_MODEL, voice: "athena", format: "mp3", text: "Good morning." })}`, ORIGIN).href);
    const stored = (store.put.mock.calls as unknown as Array<[Request, Response]>)[0]![1];
    expect(stored.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
    expect(await spoken(await w.fetch(speak(key, "Good morning.")))).toEqual({ status: 200, engine: "aura", cache: "hit", audio: "aura-mp3" });
    expect(run).toHaveBeenCalledTimes(1);
    expect((await spoken(await w.fetch(speak(key, "Good evening.")))).cache).toBe("miss");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("answers repeated ElevenLabs speech from the cache with no upstream call and no characters spent", async () => {
    const { entries } = edgeCache();
    const { w, run, gatewayRun, key } = await voiced({ ELEVENLABS_MODE: "byok", ELEVENLABS_CHARS_PER_DAY: "13" });
    expect((await spoken(await w.fetch(speak(key, "Good morning.")))).engine).toBe("elevenlabs");
    await Promise.all(w.background);
    expect(entries.size).toBe(1);
    expect(await spoken(await w.fetch(speak(key, "Good morning.")))).toEqual({ status: 200, engine: "elevenlabs", cache: "hit", audio: "elevenlabs-mp3" });
    expect(await spoken(await w.fetch(speak(key, "Good morning.")))).toEqual({ status: 200, engine: "elevenlabs", cache: "hit", audio: "elevenlabs-mp3" });
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    const registry = w.trials.named("trials");
    expect(await registry.reserveUsage({ keySha256: await sha256Hex(key), kind: "elevenlabs_chars", amount: 1, perKey: 13, perFullKey: 13, total: 13 })).toMatchObject({ ok: false, refusal: { code: "daily_limit" } });
  });

  it("keeps speaking when the cache fails", async () => {
    edgeCache(true);
    const { w, run, key } = await voiced();
    expect(await spoken(await w.fetch(speak(key, "Hello.")))).toEqual({ status: 200, engine: "aura", cache: "miss", audio: "aura-mp3" });
    await Promise.all(w.background);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keys audio by engine, voice, format and text", async () => {
    const base = { engine: "elevenlabs/eleven_flash_v2_5", voice: voice.voice_id, format: "mp3_44100_64", text: "Hi" };
    const digests = new Set(await Promise.all([base, { ...base, engine: VOICE_MODEL }, { ...base, voice: "x" }, { ...base, format: "mp3_22050_32" }, { ...base, text: "Hi." }].map(speechDigest)));
    expect(digests.size).toBe(5);
    expect(await speechDigest(base)).toMatch(/^[0-9a-f]{64}$/);
    const none = new SpeechCache(null, ORIGIN, () => undefined);
    expect(await none.find(base)).toBeNull();
    none.keep(base, new Response("x").body!);
  });
});
