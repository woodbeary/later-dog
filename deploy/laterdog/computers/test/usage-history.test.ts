import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { AI_TRIAL_TOKENS_PER_DAY, AI_WORKERS_MODEL } from "../src/ai";
import { CLEF_MODEL, KEY_CHECK_QUESTION, KEY_CHECK_STATE, utcDay } from "../src/decide";
import { ownerKeys } from "../src/owner";
import { route } from "../src/routes";
import { TRANSCRIBE_MODEL, TRANSCRIBE_SECONDS_PER_DAY } from "../src/transcribe";
import { DAY } from "../src/trial";
import { HISTORY_DAYS, OWNER_RENEW_DAYS, TOP_INSTALLS, dayList, historyDays } from "../src/trial-registry";
import { callSpend, chatSpend, dictationSpend, isSpend, voiceSpend } from "../src/usage-cost";
import { INCLUDED_VOICES, VOICE_MODEL, includedVoices } from "../src/voice";
import { ORIGIN, T0, apiRequest, body, siteverify, startTrial, trialKey, viaGateway, world } from "./fakes";

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

const OWNER = trialKey("o");
const GUEST = trialKey("g");
const ELEVENLABS = { ELEVENLABS_MODE: "secret", ELEVENLABS_API_KEY: "sk_test_voice", ELEVENLABS_CHARS_PER_DAY: "10000" };
const KEY_CHECK = { state: KEY_CHECK_STATE, model: "jev-latest", questions: { answer: { type: "noul", instructions: KEY_CHECK_QUESTION } } };
const novaAnswer = { results: { channels: [{ alternatives: [{ transcript: "Hello.", confidence: 0.99 }], detected_language: "en", language_confidence: 0.98 }] } };
const kimiAnswer = { id: "c2", object: "chat.completion", model: AI_WORKERS_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "Hi" } }], usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 } };

type SpendRow = { key_sha256: string; day: string; service: string; provider: string; units: number; micros: number };

async function service(vars: Record<string, string> = {}) {
  const run = vi.fn(async (model: string) => {
    if (model === CLEF_MODEL) return { model: "clef", answers: { answer: { type: "noul", probability: 0.99 } } };
    if (model === AI_WORKERS_MODEL) return kimiAnswer;
    if (model === TRANSCRIBE_MODEL) return novaAnswer;
    if (model === VOICE_MODEL) return new Response("aura-mp3").body;
    return { response: " the failing tests first" };
  });
  const gatewayRun = vi.fn(async () => new Response("elevenlabs-mp3", { headers: { "content-type": "audio/mpeg" } }));
  const owners = { OWNER_KEY_SHA256S: await sha256Hex(OWNER) };
  const w = await world({ AI: { run, gateway: vi.fn(() => ({ run: gatewayRun })) }, ...owners, ...vars } as unknown as Record<string, string>);
  siteverify();
  const registry = w.trials.named("trials");
  const sql = (w.trials.instances.get("trials") as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
  const spend = () => sql.exec<SpendRow>("SELECT * FROM spend ORDER BY service, provider").toArray();
  const used = (key: string, kind: string, day = utcDay(Date.now())) =>
    sql.exec<{ used: number }>("SELECT used FROM usage WHERE key_sha256 = ? AND day = ? AND kind = ?", key, day, kind).toArray()[0]?.used ?? 0;
  const total = (kind: string, day = utcDay(Date.now())) => sql.exec<{ used: number }>("SELECT used FROM usage_totals WHERE day = ? AND kind = ?", day, kind).toArray()[0]?.used ?? 0;
  return { w, run, gatewayRun, registry, sql, spend, used, total, owner: await sha256Hex(OWNER), guest: await sha256Hex(GUEST) };
}

const speak = (key: string, text: string, voiceId = INCLUDED_VOICES[1]!.voice_id) =>
  new Request(`${ORIGIN}/v1/voice/text-to-speech/${voiceId}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
  });

function wav(seconds: number): Uint8Array {
  const samples = Math.round(seconds * 16_000);
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => out.set(new TextEncoder().encode(text), at);
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return out;
}

function transcribe(key: string, seconds: number) {
  const form = new FormData();
  form.append("file", new Blob([wav(seconds)], { type: "audio/wav" }));
  return new Request(`${ORIGIN}/v1/voice/speech-to-text`, { method: "POST", headers: { "xi-api-key": key }, body: form });
}

const chat = { model: "later-dog", stream: false, messages: [{ role: "user", content: "hello" }] };

describe("who the owner is", () => {
  it("reads owner installs from a list of key hashes and ignores anything else", async () => {
    const a = await sha256Hex(OWNER);
    const b = await sha256Hex(GUEST);
    expect(ownerKeys({ OWNER_KEY_SHA256S: `${a.toUpperCase()}, ${b}\n not-a-hash ${a.slice(1)}` })).toEqual(new Set([a, b]));
    expect(ownerKeys({ OWNER_KEY_SHA256S: "" })).toEqual(new Set());
    expect(ownerKeys({})).toEqual(new Set());
  });
});

describe("what each call is estimated to cost", () => {
  it("prices dictation by the started second on the engine that wrote it down", () => {
    expect(dictationSpend("elevenlabs", 3_600)).toEqual({ service: "dictation", provider: "elevenlabs", units: 3_600, micros: 220_000 });
    expect(dictationSpend("nova-3", 59.2)).toEqual({ service: "dictation", provider: "cloudflare", units: 60, micros: 5_200 });
    expect(dictationSpend("whisper", 60)).toEqual({ service: "dictation", provider: "cloudflare", units: 60, micros: 500 });
    expect(dictationSpend("elevenlabs", 0)).toBeNull();
    expect(dictationSpend("nova-3", Number.NaN)).toBeNull();
  });

  it("prices speech by the character and chat by its input and output tokens", () => {
    expect(voiceSpend("elevenlabs", 1_000)).toEqual({ service: "voice", provider: "elevenlabs", units: 1_000, micros: 50_000 });
    expect(voiceSpend("aura", 1_000)).toEqual({ service: "voice", provider: "cloudflare", units: 1_000, micros: 30_000 });
    expect(voiceSpend("aura", 0)).toBeNull();
    expect(chatSpend("anthropic", { total: 1_000_000, output: 200_000 })).toEqual({ service: "chat", provider: "anthropic", units: 1_000_000, micros: 180_000 });
    expect(chatSpend("grok", { total: 1_000_000, output: 200_000 })).toMatchObject({ provider: "xai", micros: 260_000 });
    expect(chatSpend("workers", { total: 1_000_000, output: 200_000 })).toMatchObject({ provider: "cloudflare", micros: 1_560_000 });
    expect(chatSpend("workers", { total: 10, output: 50 })).toMatchObject({ units: 10, micros: 40 });
    expect(chatSpend("grok", { total: 0, output: 0 })).toBeNull();
  });

  it("prices typing suggestions and decisions per call, and takes only well-formed spend", () => {
    expect(callSpend("typing")).toEqual({ service: "typing", provider: "cloudflare", units: 1, micros: 28 });
    expect(callSpend("decisions")).toEqual({ service: "decisions", provider: "cloudflare", units: 1, micros: 480 });
    expect(isSpend(callSpend("typing"))).toBe(true);
    const typing = callSpend("typing");
    for (const bad of [null, {}, { ...typing, service: "search" }, { ...typing, provider: "other" }, { ...typing, micros: -1 }, { ...typing, units: Number.POSITIVE_INFINITY }]) {
      expect(isSpend(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("the owner tier", () => {
  it("has no daily limits, yet every use is still counted, with or without a trial", async () => {
    const { w, registry, owner, guest, used, total } = await service();
    expect((await startTrial(w, GUEST)).status).toBe(200);
    expect(await registry.allowUsage({ keySha256: owner, kind: "voice_chars", amount: 50_000, perKey: 10_000, total: 20_000 })).toEqual({ ok: true, tier: "owner" });
    expect(await registry.allowUsage({ keySha256: guest, kind: "voice_chars", amount: 1, perKey: 10_000, total: 20_000 })).toMatchObject({ ok: false, refusal: { code: "busy_today" } });
    expect(await registry.reserveUsage({ keySha256: owner, kind: "anthropic_tokens", amount: 1_000_000, perKey: 0, perFullKey: 0, total: 10 })).toMatchObject({ ok: true, amount: 1_000_000, tier: "owner" });
    expect(used(owner, "voice_chars")).toBe(50_000);
    expect(total("voice_chars")).toBe(50_000);
    expect(used(owner, "anthropic_tokens")).toBe(1_000_000);
    expect(await registry.allowUsage({ keySha256: guest, kind: "ai_tokens", amount: AI_TRIAL_TOKENS_PER_DAY + 1, perKey: AI_TRIAL_TOKENS_PER_DAY, total: 1e9 })).toMatchObject({ ok: false, refusal: { code: "daily_limit" } });
  });

  it("tags the owner's calls with the owner tier and speaks to the owner with later.dog's ElevenLabs voices", async () => {
    const { w, run, gatewayRun } = await service(ELEVENLABS);
    expect((await w.fetch(apiRequest("POST", "/v1/systemone", OWNER, { body: KEY_CHECK }))).status).toBe(200);
    expect(run).toHaveBeenCalledWith(CLEF_MODEL, expect.anything(), await viaGateway(OWNER, "owner"));
    const voices = await w.fetch(new Request(`${ORIGIN}/v1/voice/voices`, { headers: { "xi-api-key": OWNER } }));
    expect((await body(voices)).voices).toEqual(includedVoices(true));
    const audio = await w.fetch(speak(OWNER, "Hello."));
    expect(audio.headers.get("x-speech-engine")).toBe("elevenlabs");
    expect(await audio.text()).toBe("elevenlabs-mp3");
    expect(gatewayRun).toHaveBeenCalledWith(expect.objectContaining({ provider: "elevenlabs" }));
  });

  it("gets a computer allowance that renews instead of ending, even once an old trial is gone", async () => {
    const { w, registry, owner, guest } = await service();
    expect((await startTrial(w, OWNER)).status).toBe(200);
    expect((await startTrial(w, GUEST, "198.51.100.9")).status).toBe(200);
    const first = (await registry.holder(owner))!;
    expect(first.fullAllowance).toBe(true);
    await w.advance(8 * DAY);
    expect(await registry.holder(guest)).toBeNull();
    const renewed = (await registry.holder(owner))!;
    expect(renewed.trial.id).toBe(first.trial.id);
    expect(renewed.trial.expiresAt).toBe(first.trial.expiresAt + OWNER_RENEW_DAYS * DAY);
    expect(w.logs.mock.calls.flat().join("\n")).toContain(`trial ${first.trial.id} renewed until`);

    const fresh = await service();
    const status = await fresh.w.fetch(apiRequest("GET", "/v1/trial", OWNER));
    expect(status.status).toBe(200);
    expect((await fresh.registry.holder(fresh.owner))!.trial.expiresAt).toBe(T0 + OWNER_RENEW_DAYS * DAY);
  });
});

describe("estimated spend", () => {
  it("is kept for chat, dictation, voice, decisions and typing, on the engine that answered", async () => {
    const { w, spend, guest } = await service();
    expect((await startTrial(w, GUEST)).status).toBe(200);
    expect((await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", GUEST, { body: chat }))).status).toBe(200);
    expect((await w.fetch(transcribe(GUEST, 1.5))).status).toBe(200);
    expect((await w.fetch(speak(GUEST, "Hello there."))).status).toBe(200);
    expect((await w.fetch(apiRequest("POST", "/v1/systemone", GUEST, { body: KEY_CHECK }))).status).toBe(200);
    expect((await w.fetch(apiRequest("POST", "/v1/complete", GUEST, { body: { prefix: "Please fix" } }))).status).toBe(200);
    await Promise.all(w.background);
    const day = utcDay(T0);
    expect(spend()).toEqual([
      { key_sha256: guest, day, service: "chat", provider: "cloudflare", units: 42, micros: 46 },
      { key_sha256: guest, day, service: "decisions", provider: "cloudflare", units: 1, micros: 480 },
      { key_sha256: guest, day, service: "dictation", provider: "cloudflare", units: 2, micros: 173 },
      { key_sha256: guest, day, service: "typing", provider: "cloudflare", units: 1, micros: 28 },
      { key_sha256: guest, day, service: "voice", provider: "cloudflare", units: 12, micros: 360 },
    ]);
  });

  it("charges chat with no reported usage at what it reserved, and adds up across calls", async () => {
    const { w, run, spend, used } = await service();
    expect((await startTrial(w, GUEST)).status).toBe(200);
    run.mockImplementation(async () => ({ ...kimiAnswer, usage: undefined }) as never);
    expect((await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", GUEST, { body: chat }))).status).toBe(200);
    const reserved = used(await sha256Hex(GUEST), "ai_tokens");
    expect(reserved).toBeGreaterThan(8_000);
    expect(spend()).toEqual([expect.objectContaining({ service: "chat", units: reserved, micros: Math.round(reserved * 0.95) })]);
    run.mockImplementation(async () => kimiAnswer as never);
    expect((await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", GUEST, { body: chat }))).status).toBe(200);
    expect(spend()).toEqual([expect.objectContaining({ service: "chat", units: reserved + 42, micros: Math.round(reserved * 0.95) + 46 })]);
  });
});

describe("usage history", () => {
  it("keeps each install's days for ninety days and the daily totals for good", async () => {
    const { w, registry, sql, guest } = await service();
    await registry.chargeUsage({ keySha256: guest, kind: "transcribe_seconds", amount: 30 });
    await registry.recordSpend({ keySha256: guest, spend: dictationSpend("nova-3", 30)! });
    const first = utcDay(T0);
    await w.advance((HISTORY_DAYS - 1) * DAY);
    await registry.chargeUsage({ keySha256: guest, kind: "transcribe_seconds", amount: 5 });
    const rows = () => sql.exec<{ day: string }>("SELECT day FROM usage WHERE key_sha256 = ? ORDER BY day", guest).toArray().map((row) => row.day);
    expect(rows()).toEqual([first, utcDay(Date.now())]);
    await w.advance(DAY);
    await registry.chargeUsage({ keySha256: guest, kind: "transcribe_seconds", amount: 5 });
    expect(rows()).not.toContain(first);
    expect(sql.exec("SELECT 1 FROM spend WHERE day = ?", first).toArray()).toHaveLength(0);
    expect(sql.exec<{ used: number }>("SELECT used FROM usage_totals WHERE day = ? AND kind = 'transcribe_seconds'", first).one().used).toBe(30);
    expect(sql.exec<{ micros: number }>("SELECT micros FROM spend_totals WHERE day = ?", first).one().micros).toBe(2_600);
  });

  it("lowers the day a call started on when it settles for less after midnight", async () => {
    const { w, registry, used, total, guest } = await service();
    expect((await startTrial(w, GUEST)).status).toBe(200);
    const hold = await registry.reserveUsage({ keySha256: guest, kind: "ai_tokens", amount: 1_000, perKey: 300_000, perFullKey: 1_500_000, total: 1e9 });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    await w.advance(DAY);
    await registry.settleUsage({ keySha256: guest, kind: "ai_tokens", day: hold.day, reserved: 1_000, used: 400, spend: chatSpend("workers", { total: 400, output: 0 })! });
    expect(used(guest, "ai_tokens", hold.day)).toBe(400);
    expect(total("ai_tokens", hold.day)).toBe(400);
    expect(used(guest, "ai_tokens")).toBe(0);
  });

  it("names whole days only, newest last, from one to ninety", () => {
    expect(historyDays(7)).toBe(7);
    expect(historyDays(400)).toBe(HISTORY_DAYS);
    for (const odd of [0, -3, 1.5, Number.NaN]) expect(historyDays(odd)).toBe(30);
    expect(dayList(T0, 3)).toEqual(["2026-10-08", "2026-10-09", "2026-10-10"]);
  });
});

describe("GET /v1/usage", () => {
  it("shows an install its own days and today's allowance, and nothing of anyone else", async () => {
    const { w } = await service();
    expect((await startTrial(w, GUEST)).status).toBe(200);
    expect((await w.fetch(transcribe(GUEST, 3))).status).toBe(200);
    const response = await w.fetch(apiRequest("GET", "/v1/usage?days=7", GUEST));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const usage = await body(response);
    expect(usage).toMatchObject({ owner: false, tier: "trial", today: utcDay(T0), limits: { transcribe_seconds: TRANSCRIBE_SECONDS_PER_DAY, ai_tokens: AI_TRIAL_TOKENS_PER_DAY, grok_tokens: 0 } });
    expect(usage.days).toHaveLength(7);
    expect(usage.days[6]).toEqual({ day: utcDay(T0), used: { transcribe_seconds: 3 } });
    expect(usage.days[0]).toEqual({ day: "2026-10-04", used: {} });
    expect(JSON.stringify(usage)).not.toContain(await sha256Hex(GUEST));
  });

  it("gives the owner no limits and an estimated cost for each day", async () => {
    const { w } = await service();
    expect((await w.fetch(transcribe(OWNER, 60))).status).toBe(200);
    await Promise.all(w.background);
    const usage = await body(await w.fetch(apiRequest("GET", "/v1/usage", OWNER)));
    expect(usage).toMatchObject({ owner: true, tier: "owner", limits: null });
    expect(usage.days).toHaveLength(30);
    expect(usage.days.at(-1)).toEqual({ day: utcDay(T0), used: { transcribe_seconds: 60 }, micros: 5_200 });
  });

  it("refuses browsers, strangers and ended trials", async () => {
    const { w } = await service();
    expect((await w.fetch(apiRequest("GET", "/v1/usage", trialKey("z")))).status).toBe(401);
    expect((await w.fetch(apiRequest("GET", "/v1/usage", OWNER, { headers: { origin: ORIGIN } }))).status).toBe(403);
    expect((await w.fetch(new Request(`${ORIGIN}/v1/usage`))).status).toBe(401);
    expect((await w.fetch(apiRequest("POST", "/v1/usage", OWNER))).status).toBe(405);
  });
});

describe("the owner's report", () => {
  it("is not there for anyone but an owner", async () => {
    const { w } = await service();
    expect((await startTrial(w, GUEST)).status).toBe(200);
    expect((await w.fetch(apiRequest("GET", "/v1/usage/owner", GUEST))).status).toBe(404);
    expect((await w.fetch(apiRequest("PUT", "/v1/usage/owner/grants", GUEST, { body: { grants: [] } }))).status).toBe(404);
    expect((await w.fetch(apiRequest("GET", "/v1/usage/owner", trialKey("z")))).status).toBe(404);
  });

  it("sums every install's use and spend by day, ranks the top installs by trial id, and never shows a key hash", async () => {
    const { w, registry, owner, guest } = await service();
    expect((await startTrial(w, GUEST)).status).toBe(200);
    expect((await w.fetch(apiRequest("GET", "/v1/trial", OWNER))).status).toBe(200);
    expect((await w.fetch(transcribe(GUEST, 60))).status).toBe(200);
    expect((await w.fetch(transcribe(OWNER, 6))).status).toBe(200);
    await Promise.all(w.background);
    await w.advance(DAY);
    expect((await w.fetch(apiRequest("POST", "/v1/systemone", OWNER, { body: KEY_CHECK }))).status).toBe(200);
    const response = await w.fetch(apiRequest("GET", "/v1/usage/owner?days=7", OWNER));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(owner);
    expect(text).not.toContain(guest);
    const report = JSON.parse(text);
    const yesterday = utcDay(T0);
    const today = utcDay(T0 + DAY);
    expect(report.today).toBe(today);
    expect(report.days).toEqual(dayList(T0 + DAY, 7));
    expect(report.usage).toEqual([
      { day: yesterday, kind: "transcribe_seconds", used: 66 },
      { day: today, kind: "decisions", used: 1 },
    ]);
    expect(report.active).toEqual([{ day: yesterday, installs: 2 }, { day: today, installs: 1 }]);
    expect(report.activeInstalls).toBe(2);
    expect(report.spend).toEqual([
      { day: yesterday, service: "dictation", provider: "cloudflare", units: 66, micros: 5_720 },
      { day: today, service: "decisions", provider: "cloudflare", units: 1, micros: 480 },
    ]);
    expect(report.top).toEqual([
      { label: (await registry.holder(guest))!.trial.id, tier: "trial", owner: false, micros: 5_200, services: [{ service: "dictation", units: 60, micros: 5_200 }] },
      { label: (await registry.holder(owner))!.trial.id, tier: "owner", owner: true, micros: 1_000, services: [{ service: "dictation", units: 6, micros: 520 }, { service: "decisions", units: 1, micros: 480 }] },
    ]);
    expect(report.top.length).toBeLessThanOrEqual(TOP_INSTALLS);
  });

  it("keeps the grants the owner sets and how much of each has been spent since it started", async () => {
    const { w } = await service();
    expect((await w.fetch(transcribe(OWNER, 60))).status).toBe(200);
    await Promise.all(w.background);
    const put = (grants: unknown) => w.fetch(apiRequest("PUT", "/v1/usage/owner/grants", OWNER, { body: { grants } }));
    const saved = await put([{ provider: "cloudflare", usd: 2_500, since: utcDay(T0) }, { provider: "xai", usd: 9_800.004, since: "2026-11-01" }]);
    expect(saved.status).toBe(200);
    expect((await body(saved)).grants).toEqual([
      { provider: "cloudflare", usd: 2_500, since: utcDay(T0), spentMicros: 5_200 },
      { provider: "xai", usd: 9_800, since: "2026-11-01", spentMicros: 0 },
    ]);
    expect((await body(await w.fetch(apiRequest("GET", "/v1/usage/owner", OWNER)))).grants).toHaveLength(2);
    for (const bad of [
      [{ provider: "other", usd: 1, since: "2026-10-01" }],
      [{ provider: "xai", usd: -1, since: "2026-10-01" }],
      [{ provider: "xai", usd: 1, since: "October" }],
      [{ provider: "xai", usd: 1, since: "2026-13-45" }],
      [{ provider: "xai", usd: 1, since: "2026-10-01" }, { provider: "xai", usd: 2, since: "2026-10-01" }],
      "all of it",
    ]) {
      expect((await put(bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await body(await put([]))).grants).toEqual([]);
  });
});

describe("usage routes", () => {
  it("answers each usage path on its own method only", () => {
    expect(route("GET", "/v1/usage")).toEqual({ kind: "usage" });
    expect(route("GET", "/v1/usage/owner")).toEqual({ kind: "usage_owner" });
    expect(route("PUT", "/v1/usage/owner/grants")).toEqual({ kind: "usage_grants" });
    expect(route("DELETE", "/v1/usage")).toEqual({ kind: "method_not_allowed", allow: ["GET"] });
    expect(route("POST", "/v1/usage/owner")).toEqual({ kind: "method_not_allowed", allow: ["GET"] });
    expect(route("GET", "/v1/usage/owner/grants")).toEqual({ kind: "method_not_allowed", allow: ["PUT"] });
    expect(route("GET", "/v1/usage/other")).toEqual({ kind: "not_found", api: true });
  });
});
