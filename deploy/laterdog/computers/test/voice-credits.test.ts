import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { SPEECH_CACHE_PATH, SpeechCache, speechDigest } from "../src/speech-cache";
import { DAY } from "../src/trial";
import { ELEVENLABS_PLAN_CHARS_PER_DAY, INCLUDED_VOICES, VOICE_MODEL, elevenLabsBudget, elevenLabsRequest, elevenLabsVoice } from "../src/voice";
import { ORIGIN, type World, body, givePlan, siteverify, startTrial, trialKey, viaGateway, world } from "./fakes";

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

type KeyTier = "trial" | "home" | "plan";

async function keyed(w: World, fill: string, tier: KeyTier, ip?: string) {
  const key = trialKey(fill);
  expect((await startTrial(w, key, ip)).status).toBe(200);
  if (tier === "plan") await givePlan(w, key);
  if (tier === "home") await w.trials.named("trials").grantHome({ keySha256: await sha256Hex(key), limitMs: 60_000, windowMs: DAY });
  return key;
}

async function voiced(vars: Record<string, string> = {}, options: { elevenLabs?: "ok" | "down"; tier?: KeyTier } = {}) {
  const run = vi.fn(async () => new Response("aura-mp3").body);
  const gatewayRun = vi.fn(async () => options.elevenLabs === "down"
    ? new Response("{\"detail\":{\"status\":\"quota_exceeded\"}}", { status: 401 })
    : new Response("elevenlabs-mp3", { headers: { "content-type": "audio/mpeg" } }));
  const gateway = vi.fn(() => ({ run: gatewayRun }));
  const w = await world({ AI: { run, gateway }, ...vars } as unknown as Record<string, string>);
  siteverify();
  const key = await keyed(w, "v", options.tier ?? "plan");
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

const voicesFor = async (w: World, key: string) => (await body(await w.fetch(new Request(`${ORIGIN}/v1/voice/voices`, { headers: { "xi-api-key": key } })))).voices;

describe("spending ElevenLabs credits on purpose", () => {
  it("stays on Aura while ELEVENLABS_MODE is off, even with a key set", async () => {
    const switchedOff: Array<Record<string, string>> = [
      { ELEVENLABS_API_KEY: "sk_test_voice" },
      { ELEVENLABS_API_KEY: "sk_test_voice", ELEVENLABS_CHARS_PER_DAY: "1000" },
      { ELEVENLABS_MODE: "secret", ELEVENLABS_CHARS_PER_DAY: "1000" },
      { ELEVENLABS_MODE: "byok" },
      { ELEVENLABS_MODE: "byok", ELEVENLABS_CHARS_PER_DAY: "0" },
      { ...BYOK, ELEVENLABS_PLAN_CHARS_PER_DAY: "0" },
      { ...BYOK, ELEVENLABS_PLAN_CHARS_PER_DAY: "lots" },
    ];
    for (const vars of switchedOff) {
      const { w, run, gatewayRun, key } = await voiced(vars);
      expect(await spoken(await w.fetch(speak(key, "Hello.")))).toEqual({ status: 200, engine: "aura", cache: "miss", audio: "aura-mp3" });
      expect(gatewayRun, JSON.stringify(vars)).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(1);
      expect((await voicesFor(w, key))[1].labels.description).toBe("calm");
      vi.restoreAllMocks();
    }
  });

  it("lets the AI Gateway supply the key in byok mode for a plan key, and tags the call with the key's user and tier", async () => {
    const { w, run, gateway, gatewayRun, key } = await voiced(BYOK);
    expect(await spoken(await w.fetch(speak(key, "Hello.")))).toEqual({ status: 200, engine: "elevenlabs", cache: "miss", audio: "elevenlabs-mp3" });
    expect(run).not.toHaveBeenCalled();
    expect(gateway).toHaveBeenCalledWith("default");
    const sent = (gatewayRun.mock.calls as unknown as Array<[{ provider: string; headers: Record<string, unknown> }]>)[0]![0];
    expect(sent.provider).toBe("elevenlabs");
    expect(sent.headers).not.toHaveProperty("xi-api-key");
    expect(JSON.parse(String(sent.headers["cf-aig-metadata"]))).toEqual((await viaGateway(key, "plan")).gateway.metadata);
    expect(sent.headers["cf-aig-collect-log"]).toBe(false);
    expect(await voicesFor(w, key)).toEqual(INCLUDED_VOICES);
  });

  it("never sends a trial or free home key to ElevenLabs", async () => {
    for (const tier of ["trial", "home"] as const) {
      const { w, run, gatewayRun, key } = await voiced({ ...BYOK, ELEVENLABS_CHARS_PER_DAY: "100000" }, { tier });
      for (const text of ["Hello.", "Again.", "x".repeat(2_000)]) {
        expect((await spoken(await w.fetch(speak(key, text)))).engine, tier).toBe("aura");
      }
      expect(gatewayRun, tier).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(3);
      expect(run).toHaveBeenCalledWith(VOICE_MODEL, { text: "Hello.", speaker: "athena", encoding: "mp3" }, await viaGateway(key, tier));
      expect((await voicesFor(w, key))[1].labels.description).toBe("calm");
      vi.restoreAllMocks();
    }
  });

  it("refuses ElevenLabs characters to a trial key even if one is asked for directly", async () => {
    const { w, key } = await voiced({ ...BYOK, ELEVENLABS_CHARS_PER_DAY: "100000" }, { tier: "trial" });
    const voice = elevenLabsVoice({ ...BYOK, ELEVENLABS_CHARS_PER_DAY: "100000" } as unknown as Env)!;
    const registry = w.trials.named("trials");
    expect(await registry.reserveUsage({ keySha256: await sha256Hex(key), amount: 1, ...elevenLabsBudget(voice) })).toMatchObject({ ok: false, refusal: { code: "daily_limit" } });
  });

  it("gives a plan key 1,000 ElevenLabs characters a day, then Aura-2 until midnight UTC", async () => {
    expect(ELEVENLABS_PLAN_CHARS_PER_DAY).toBe(1_000);
    const { w, run, gatewayRun, key } = await voiced({ ...BYOK, ELEVENLABS_CHARS_PER_DAY: "100000" });
    expect((await spoken(await w.fetch(speak(key, "a".repeat(600))))).engine).toBe("elevenlabs");
    expect((await spoken(await w.fetch(speak(key, "b".repeat(400))))).engine).toBe("elevenlabs");
    expect(await spoken(await w.fetch(speak(key, "c")))).toEqual({ status: 200, engine: "aura", cache: "miss", audio: "aura-mp3" });
    expect((await spoken(await w.fetch(speak(key, "d".repeat(300))))).engine).toBe("aura");
    expect(gatewayRun).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith(VOICE_MODEL, { text: "c", speaker: "athena", encoding: "mp3" }, await viaGateway(key, "plan"));
    const other = await keyed(w, "w", "plan", "198.51.100.9");
    expect((await spoken(await w.fetch(speak(other, "Hello.")))).engine).toBe("elevenlabs");
    await w.advance(DAY);
    expect((await spoken(await w.fetch(speak(key, "Hello.")))).engine).toBe("elevenlabs");
  });

  it("takes the per-plan allowance from ELEVENLABS_PLAN_CHARS_PER_DAY", async () => {
    const { w, gatewayRun, key } = await voiced({ ...BYOK, ELEVENLABS_PLAN_CHARS_PER_DAY: "10" });
    expect((await spoken(await w.fetch(speak(key, "Hello.")))).engine).toBe("elevenlabs");
    expect((await spoken(await w.fetch(speak(key, "Again.")))).engine).toBe("aura");
    expect(gatewayRun).toHaveBeenCalledTimes(1);
  });

  it("keeps the shared daily budget on top of each plan key's allowance", async () => {
    const { w, gatewayRun, key } = await voiced({ ELEVENLABS_MODE: "byok", ELEVENLABS_CHARS_PER_DAY: "10" });
    expect((await spoken(await w.fetch(speak(key, "Hello.")))).engine).toBe("elevenlabs");
    const other = await keyed(w, "w", "plan", "198.51.100.9");
    expect((await spoken(await w.fetch(speak(other, "Hello.")))).engine).toBe("aura");
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    await w.advance(DAY);
    expect((await spoken(await w.fetch(speak(other, "Hello.")))).engine).toBe("elevenlabs");
  });

  it("gives the characters back when ElevenLabs refuses, so a failure costs no budget", async () => {
    const { w, run, gatewayRun, key } = await voiced({ ELEVENLABS_MODE: "byok", ELEVENLABS_CHARS_PER_DAY: "6" }, { elevenLabs: "down" });
    expect((await spoken(await w.fetch(speak(key, "Hello.")))).engine).toBe("aura");
    expect((await spoken(await w.fetch(speak(key, "Hello.")))).engine).toBe("aura");
    expect(gatewayRun).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("uses the Worker's own key only in secret mode", () => {
    const env = (vars: Record<string, string>) => vars as unknown as Env;
    expect(elevenLabsVoice(env({ ELEVENLABS_MODE: "secret", ELEVENLABS_API_KEY: " sk ", ELEVENLABS_CHARS_PER_DAY: "500" }))).toEqual({ key: "sk", charsPerDay: 500, planCharsPerDay: 1_000 });
    expect(elevenLabsVoice(env({ ELEVENLABS_MODE: "byok", ELEVENLABS_API_KEY: "sk", ELEVENLABS_CHARS_PER_DAY: "500", ELEVENLABS_PLAN_CHARS_PER_DAY: " 250 " }))).toEqual({ charsPerDay: 500, planCharsPerDay: 250 });
    expect(elevenLabsVoice(env({ ELEVENLABS_MODE: "off", ELEVENLABS_API_KEY: "sk", ELEVENLABS_CHARS_PER_DAY: "500" }))).toBeNull();
    expect(elevenLabsVoice(env({ ELEVENLABS_MODE: "byok", ELEVENLABS_CHARS_PER_DAY: "lots" }))).toBeNull();
    expect(elevenLabsVoice(env({ ELEVENLABS_MODE: "byok", ELEVENLABS_CHARS_PER_DAY: "500", ELEVENLABS_PLAN_CHARS_PER_DAY: "-5" }))).toBeNull();
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
    expect(await registry.reserveUsage({ keySha256: await sha256Hex(key), kind: "elevenlabs_chars", amount: 1, perKey: 0, perFullKey: 13, total: 13 })).toMatchObject({ ok: false, refusal: { code: "daily_limit" } });
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
