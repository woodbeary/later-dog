import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { AI_DEFAULT_MODEL, chatRequest, streamedTokens, tokensOf } from "../src/ai";
import { DAY } from "../src/trial";
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

const sse = (chunks: unknown[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder();
    for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  },
});

async function ai(vars: Record<string, string> = { XAI_API_KEY: "xai-test" }) {
  const gatewayRun = vi.fn(async (request: { query: { stream?: boolean } }) => request.query.stream
    ? new Response(sse([{ choices: [{ delta: { content: "Hi" } }] }, { choices: [], usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 } }]), { headers: { "content-type": "text/event-stream" } })
    : Response.json({ choices: [{ message: { role: "assistant", content: "Hi" } }], usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 } }));
  const gateway = vi.fn(() => ({ run: gatewayRun }));
  const w = await world({ AI: { run: vi.fn(), gateway }, ...vars } as unknown as Record<string, string>);
  siteverify();
  const key = trialKey("k");
  expect((await startTrial(w, key)).status).toBe(200);
  const used = async () => (await w.trials.named("trials").usageLeft({ keySha256: await sha256Hex(key), kind: "ai_tokens", perKey: 1_041, total: 10_000_000 })).ok;
  return { w, key, gateway, gatewayRun, used };
}

const chat = (stream: boolean, extra: Record<string, unknown> = {}) => ({ model: "grok-4.7", stream, messages: [{ role: "user", content: "hello" }], ...extra });

describe("the included AI", () => {
  it("answers a trial's chat with Grok through the AI Gateway on the included model, and counts its tokens", async () => {
    const { w, key, gateway, gatewayRun, used } = await ai();
    const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(false, { api_key: "x", n: 5, max_tokens: 900_000 }) }));
    expect(response.status).toBe(200);
    expect((await body(response)).choices[0].message.content).toBe("Hi");
    expect(gateway).toHaveBeenCalledWith("default");
    const sent = gatewayRun.mock.calls[0]![0] as { provider: string; endpoint: string; headers: Record<string, unknown>; query: Record<string, unknown> };
    expect(sent).toMatchObject({ provider: "grok", endpoint: "v1/chat/completions", headers: { Authorization: "Bearer xai-test", "cf-aig-collect-log": false } });
    expect(sent.query).toEqual({ model: AI_DEFAULT_MODEL, stream: false, messages: chat(false).messages, max_tokens: 32_000 });
    expect(await used()).toBe(true);
  });

  it("streams the answer back and charges the tokens the stream reports", async () => {
    const { w, key, gatewayRun, used } = await ai();
    const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(true) }));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toContain('"content":"Hi"');
    await Promise.all(w.background);
    expect((gatewayRun.mock.calls[0]![0] as { query: Record<string, unknown> }).query).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(await used()).toBe(true);
    await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(false) }));
    expect(await used()).toBe(false);
  });

  it("refuses strangers, browsers, empty chats and ended trials, and says so when it isn't set up", async () => {
    const { w, key, gatewayRun } = await ai();
    expect((await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", trialKey("z"), { body: chat(false) }))).status).toBe(401);
    expect((await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(false), headers: { origin: ORIGIN } }))).status).toBe(403);
    expect((await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: { messages: [] } }))).status).toBe(400);
    await w.advance(8 * DAY);
    expect((await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(false) }))).status).toBe(401);
    expect(gatewayRun).not.toHaveBeenCalled();
    const bare = await ai({});
    expect((await bare.w.fetch(apiRequest("POST", "/v1/ai/chat/completions", bare.key, { body: chat(false) }))).status).toBe(503);
  });

  it("reads token counts from answers and streams", async () => {
    expect(tokensOf({ total_tokens: 12 })).toBe(12);
    expect(tokensOf({ prompt_tokens: 10, completion_tokens: 5 })).toBe(15);
    expect(tokensOf(undefined)).toBe(0);
    expect(await streamedTokens(sse([{ choices: [] }, { usage: { total_tokens: 77 } }]))).toBe(77);
    expect(chatRequest({ messages: [{ role: "user", content: "x" }], stream: true }, "m")).toMatchObject({ ok: true, request: { model: "m", stream: true, stream_options: { include_usage: true } } });
  });
});
