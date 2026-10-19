import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { AI_DEFAULT_MODEL, AI_MAX_BODY_BYTES, AI_TRIAL_TOKENS_PER_DAY, GROK_TOKENS_PER_DAY, type ChatRequest, chatRequest } from "../src/ai";
import { type UsageKind, utcDay } from "../src/decide";
import { DAY } from "../src/trial";
import { IMAGE_TOKENS_ESTIMATE, RESERVE_BYTES_PER_TOKEN, SIZE_CHECK_BYTES_PER_TOKEN, chatEstimate, promptTokens } from "../src/usage-reserve";
import { ORIGIN, type World, apiRequest, body, siteverify, startTrial, trialKey, world } from "./fakes";

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

const ANSWER_TOKENS = 42;
const CHAT = "/v1/ai/chat/completions";

const chat = (extra: Record<string, unknown> = {}) => ({ model: "later-dog", stream: false, messages: [{ role: "user", content: "hello" }], ...extra });

async function setup(vars: Record<string, unknown> = {}) {
  let release: () => void = () => undefined;
  const gate = { held: false, opened: new Promise<void>((resolve) => { release = resolve; }) };
  const answer = { choices: [{ message: { role: "assistant", content: "Hi" } }], usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: ANSWER_TOKENS } };
  const run = vi.fn(async () => {
    if (gate.held) await gate.opened;
    return answer;
  });
  const gatewayRun = vi.fn(async () => Response.json(answer));
  const w = await world({ AI: { run, gateway: vi.fn(() => ({ run: gatewayRun })) }, ...vars } as unknown as Record<string, string>);
  siteverify();
  const key = trialKey("r");
  expect((await startTrial(w, key)).status).toBe(200);
  const keySha256 = await sha256Hex(key);
  return { w, key, keySha256, run, gatewayRun, gate, release: () => release() };
}

function usedToday(w: World, keySha256: string, kind: UsageKind): number {
  const registry = w.trials.instances.get("trials") as unknown as { ctx: DurableObjectState };
  const row = registry.ctx.storage.sql.exec<{ used: number }>("SELECT used FROM usage WHERE key_sha256 = ? AND day = ? AND kind = ?", keySha256, utcDay(w.clock.now), kind).toArray()[0];
  return row?.used ?? 0;
}

function reserveOf(extra: Record<string, unknown> = {}): number {
  const parsed = chatRequest(chat(extra), AI_DEFAULT_MODEL);
  if (!parsed.ok) throw new Error("The test chat is not valid.");
  return chatEstimate(parsed.request).reserve;
}

describe("reserving free AI tokens before the call", () => {
  it("lets none of 60 concurrent calls through when the key is one token below its cap", async () => {
    const { w, key, keySha256, run } = await setup();
    await w.trials.named("trials").allowUsage({ keySha256, kind: "ai_tokens", amount: AI_TRIAL_TOKENS_PER_DAY - 1, perKey: AI_TRIAL_TOKENS_PER_DAY, total: Number.MAX_SAFE_INTEGER });
    const answers = await Promise.all(Array.from({ length: 60 }, () => w.fetch(apiRequest("POST", CHAT, key, { body: chat() }))));
    expect(answers.map((answer) => answer.status)).toEqual(Array(60).fill(429));
    expect((await body(answers[0]!)).error.code).toBe("daily_limit");
    expect(run).not.toHaveBeenCalled();
    expect(usedToday(w, keySha256, "ai_tokens")).toBe(AI_TRIAL_TOKENS_PER_DAY - 1);
  });

  it("holds 60 concurrent calls in flight to the cap, refuses the rest, then keeps only what was used", async () => {
    const { w, key, keySha256, run, gate, release } = await setup();
    gate.held = true;
    const pending = Array.from({ length: 60 }, () => w.fetch(apiRequest("POST", CHAT, key, { body: chat() })));
    await vi.waitFor(() => expect(usedToday(w, keySha256, "ai_tokens")).toBeGreaterThan(AI_TRIAL_TOKENS_PER_DAY - reserveOf()));
    const fits = Math.floor(AI_TRIAL_TOKENS_PER_DAY / reserveOf());
    expect(usedToday(w, keySha256, "ai_tokens")).toBeLessThanOrEqual(AI_TRIAL_TOKENS_PER_DAY);
    release();
    const answers = await Promise.all(pending);
    const statuses = answers.map((answer) => answer.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(fits);
    expect(statuses.filter((status) => status === 429)).toHaveLength(60 - fits);
    expect(run).toHaveBeenCalledTimes(fits);
    expect(usedToday(w, keySha256, "ai_tokens")).toBe(fits * ANSWER_TOKENS);
  });

  it("gives the whole reservation back when no model answers", async () => {
    const { w, key, keySha256 } = await setup();
    (w.env.AI as { run: () => Promise<unknown> }).run = async () => Promise.reject(new Error("3040: Capacity temporarily exceeded"));
    expect((await w.fetch(apiRequest("POST", CHAT, key, { body: chat() }))).status).toBe(502);
    expect(usedToday(w, keySha256, "ai_tokens")).toBe(0);
  });

  it("keeps the whole reservation when an answer reports no usage", async () => {
    const { w, key, keySha256 } = await setup();
    (w.env.AI as { run: () => Promise<unknown> }).run = async () => ({ choices: [{ message: { role: "assistant", content: "Hi" } }] });
    expect((await w.fetch(apiRequest("POST", CHAT, key, { body: chat() }))).status).toBe(200);
    expect(usedToday(w, keySha256, "ai_tokens")).toBe(reserveOf());
  });

  it("charges a call settled after midnight to the new day only for what went past its reservation", async () => {
    const { w, key, keySha256, gate, release } = await setup();
    gate.held = true;
    const pending = w.fetch(apiRequest("POST", CHAT, key, { body: chat() }));
    await vi.waitFor(() => expect(usedToday(w, keySha256, "ai_tokens")).toBe(reserveOf()));
    w.clock.now += DAY;
    release();
    expect((await pending).status).toBe(200);
    expect(usedToday(w, keySha256, "ai_tokens")).toBe(0);
  });
});

const DESKTOP_COMPACTS_AT_TOKENS = 80_000;

const typicalTools = Array.from({ length: 40 }, (_, index) => ({
  type: "function",
  function: {
    name: `tool_${index}`,
    description: "Does one thing on the computer for the dog and reports what happened, in a sentence or two.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Where to act." }, text: { type: "string", description: "What to write." }, timeoutMs: { type: "number" } }, required: ["path"] },
  },
}));

function transcriptJustUnderCompaction(): Array<{ role: string; content: string }> {
  const turn = "The dog opened the project, read the failing test, and explained the fix in plain words. ";
  const messages: Array<{ role: string; content: string }> = [];
  let bytes = 0;
  while ((bytes + turn.length * 20) / SIZE_CHECK_BYTES_PER_TOKEN < DESKTOP_COMPACTS_AT_TOKENS - 500) {
    const content = turn.repeat(20);
    messages.push({ role: messages.length % 2 === 0 ? "user" : "assistant", content });
    bytes += content.length;
  }
  return messages;
}

describe("prompt size", () => {
  it("answers a long chat with a typical tool list that the desktop would not compact yet", async () => {
    const { w, key, run } = await setup();
    const messages = transcriptJustUnderCompaction();
    const transcriptBytes = messages.reduce((total, message) => total + message.content.length, 0);
    expect(transcriptBytes / SIZE_CHECK_BYTES_PER_TOKEN).toBeGreaterThan(DESKTOP_COMPACTS_AT_TOKENS - 1_000);
    expect(transcriptBytes / SIZE_CHECK_BYTES_PER_TOKEN).toBeLessThan(DESKTOP_COMPACTS_AT_TOKENS);
    const request = chatRequest(chat({ messages, tools: typicalTools }), AI_DEFAULT_MODEL);
    if (!request.ok) throw new Error("The test chat is not valid.");
    expect(promptTokens(request.request, RESERVE_BYTES_PER_TOKEN)).toBeGreaterThan(100_000);
    expect(chatEstimate(request.request).reserve).toBeGreaterThan(chatEstimate(request.request).prompt);
    expect((await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ messages, tools: typicalTools }) }))).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses prompts estimated over 100k tokens with 413 before any model runs", async () => {
    const { w, key, run } = await setup();
    const long = await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ messages: [{ role: "user", content: "a".repeat(440_000) }] }) }));
    expect(long.status).toBe(413);
    expect((await body(long)).error.code).toBe("prompt_too_large");
    const huge = await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ messages: [{ role: "user", content: "a".repeat(AI_MAX_BODY_BYTES) }] }) }));
    expect(huge.status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });

  it("counts an inline screenshot as one image, not as its base64 text", async () => {
    const { w, key, run } = await setup();
    const screenshot = `data:image/jpeg;base64,${"A".repeat(400_000)}`;
    const content = [{ type: "text", text: "what is on screen?" }, { type: "image_url", image_url: { url: screenshot } }];
    const request = { ...chat({ messages: [{ role: "user", content }] }), max_tokens: 1 } as ChatRequest;
    expect(promptTokens(request)).toBeLessThan(IMAGE_TOKENS_ESTIMATE + 100);
    expect(promptTokens({ ...chat({ messages: [{ role: "user", content: screenshot }] }), max_tokens: 1 } as ChatRequest)).toBeGreaterThan(100_000);
    expect((await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ messages: [{ role: "user", content }] }) }))).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses image links and other non-text parts with 400 before any model runs", async () => {
    const { w, key, keySha256, run } = await setup();
    const remote = Array.from({ length: 50 }, (_, index) => ({ type: "image_url", image_url: { url: `https://x.example/${index}.png` } }));
    const refused = [
      [{ type: "text", text: "describe these" }, ...remote],
      [{ type: "image_url", image_url: { url: "http://x.example/1.png" } }],
      [{ type: "image_url", image_url: { url: "data:image/svg+xml;base64,PHN2Zz4=" } }],
      [{ type: "image_url", image_url: "https://x.example/1.png" }],
      [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }],
      [{ type: "file", file: { file_id: "file-1" } }],
      ["plain string part"],
    ];
    for (const content of refused) {
      const response = await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ messages: [{ role: "user", content }] }) }));
      expect(response.status, JSON.stringify(content).slice(0, 80)).toBe(400);
      expect((await body(response)).error.code).toBe("invalid_request");
    }
    const toolImage = await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ messages: [{ role: "user", content: "look" }, { role: "tool", tool_call_id: "c", content: remote }] }) }));
    expect(toolImage.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
    expect(usedToday(w, keySha256, "ai_tokens")).toBe(0);
  });

  it("counts every image part at the image estimate whatever its url, so many small images reach 413", async () => {
    const { w, key, run } = await setup();
    const tiny = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
    const remote = { type: "image_url", image_url: { url: "https://x.example/1.png" } };
    const audio = { type: "input_audio", input_audio: { data: "AAAA", format: "wav" } };
    const one = (part: unknown) => promptTokens({ ...chat({ messages: [{ role: "user", content: [part] }] }), max_tokens: 1 } as ChatRequest);
    expect(one(remote)).toBeGreaterThanOrEqual(IMAGE_TOKENS_ESTIMATE);
    expect(one(audio)).toBeGreaterThanOrEqual(IMAGE_TOKENS_ESTIMATE);
    expect(one(tiny)).toBeGreaterThanOrEqual(IMAGE_TOKENS_ESTIMATE);
    const images = Math.floor(100_000 / IMAGE_TOKENS_ESTIMATE) + 1;
    const many = await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ messages: [{ role: "user", content: Array(images).fill(tiny) }] }) }));
    expect(many.status).toBe(413);
    expect((await body(many)).error.code).toBe("prompt_too_large");
    expect(run).not.toHaveBeenCalled();
    expect((await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }, tiny] }] }) }))).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("caps output at 8k tokens", async () => {
    const { w, key, run } = await setup();
    await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ max_tokens: 900_000 }) }));
    expect(run.mock.calls[0]).toBeDefined();
    expect((run.mock.calls[0] as unknown as [string, { max_tokens: number }])[1].max_tokens).toBe(8_000);
  });
});

describe("Grok by name", () => {
  it("never sends a free trial's Grok pick to xAI while Workers AI answers", async () => {
    const { w, key, keySha256, run, gatewayRun } = await setup({ XAI_API_KEY: "xai-test" });
    for (const model of ["grok-4.3", "grok-4-1-fast-reasoning", "grok"]) {
      expect((await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ model }) }))).status).toBe(200);
    }
    expect(gatewayRun).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(3);
    expect(usedToday(w, keySha256, "grok_tokens")).toBe(0);
  });

  it("draws a home key's Grok pick from its own Grok budget, then moves it to Workers AI when that is used up", async () => {
    const { w, key, keySha256, run, gatewayRun } = await setup({ XAI_API_KEY: "xai-test" });
    await w.trials.named("trials").grantHome({ keySha256, limitMs: 60_000, windowMs: DAY });
    expect((await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ model: "grok-4.3" }) }))).status).toBe(200);
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    expect(usedToday(w, keySha256, "grok_tokens")).toBe(ANSWER_TOKENS);
    expect(usedToday(w, keySha256, "ai_tokens")).toBe(0);
    await w.trials.named("trials").allowUsage({ keySha256, kind: "grok_tokens", amount: GROK_TOKENS_PER_DAY - ANSWER_TOKENS - 1, perKey: GROK_TOKENS_PER_DAY, total: Number.MAX_SAFE_INTEGER });
    expect((await w.fetch(apiRequest("POST", CHAT, key, { body: chat({ model: "grok-4.3" }) }))).status).toBe(200);
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(usedToday(w, keySha256, "ai_tokens")).toBe(ANSWER_TOKENS);
  });
});

describe("rate limiter outages", () => {
  const down = { limit: async () => { throw new Error("limiter down"); } };

  it("refuses chat, speech and dictation while the limiter is down, and keeps decisions working", async () => {
    const { w, key, run } = await setup({ INCLUDED_LIMIT: down });
    expect((await w.fetch(apiRequest("POST", CHAT, key, { body: chat() }))).status).toBe(429);
    expect((await w.fetch(apiRequest("POST", "/v1/voice/text-to-speech/JBFqnCBsd6RMkjVDRZzb", key, { body: { text: "hi" } }))).status).toBe(429);
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(44)]), "a.wav");
    expect((await w.fetch(new Request(`${ORIGIN}/v1/voice/speech-to-text`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form }))).status).toBe(429);
    expect(run).not.toHaveBeenCalled();
    const decision = await w.fetch(apiRequest("POST", "/v1/systemone", key, { body: { state: { purpose: "later.dog is checking that a decision-model key works." }, questions: { answer: { type: "noul", instructions: "Is this a connection check?" } } } }));
    expect(decision.status).toBe(200);
  });
});
