import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { AI_BUSY, AI_WORKERS_MODEL, GROK_DEFAULT_MODEL, chatRequest, openAiStream, plainErrors, streamedTokens, tokensOf, usableStream } from "../src/ai";
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

const workersSse = (lines: unknown[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder();
    for (const line of lines) controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  },
});

const KIMI_STREAM = [
  { id: "c1", object: "chat.completion.chunk", created: 1, model: AI_WORKERS_MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "" } }], usage: { prompt_tokens: 900, completion_tokens: 0, total_tokens: 900 }, p: "pad" },
  { id: "c1", object: "chat.completion.chunk", created: 1, model: AI_WORKERS_MODEL, choices: [{ index: 0, delta: { content: "Hi" } }], usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 }, p: "pad" },
  { id: "c1", object: "chat.completion.chunk", created: 1, model: AI_WORKERS_MODEL, choices: [], usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 }, p: "pad" },
  { response: "", usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 } },
];

const GROK_FIRST = { XAI_API_KEY: "xai-test", TRIAL_AI_FIRST: "xai" };
const XAI_ERROR = { error: { message: "The model is currently at capacity. Use a higher service tier: https://docs.example/priority", type: "server_error" } };

async function ai(vars: Record<string, string> = GROK_FIRST, grok: "ok" | "down" | "busy" = "ok", workers: "ok" | "down" = "ok") {
  const gatewayRun = vi.fn(async (request: { query: { stream?: boolean } }) => grok === "down"
    ? new Response("{\"error\":\"Model not found\"}", { status: 404 })
    : grok === "busy"
      ? request.query.stream ? new Response(sse([XAI_ERROR]), { headers: { "content-type": "text/event-stream" } }) : Response.json(XAI_ERROR)
      : request.query.stream
      ? new Response(sse([{ choices: [{ delta: { content: "Hi" } }] }, { choices: [], usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 } }]), { headers: { "content-type": "text/event-stream" } })
      : Response.json({ choices: [{ message: { role: "assistant", content: "Hi" } }], usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 } }));
  const gateway = vi.fn(() => ({ run: gatewayRun }));
  const run = vi.fn(async (_model: string, input: { stream?: boolean }) => workers === "down"
    ? Promise.reject(new Error("3040: Capacity temporarily exceeded"))
    : input.stream
    ? workersSse(KIMI_STREAM)
    : { id: "c2", object: "chat.completion", model: AI_WORKERS_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "Hi" } }], usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 } });
  const w = await world({ AI: { run, gateway }, ...vars } as unknown as Record<string, string>);
  siteverify();
  const key = trialKey("k");
  expect((await startTrial(w, key)).status).toBe(200);
  const used = async () => (await w.trials.named("trials").usageLeft({ keySha256: await sha256Hex(key), kind: "ai_tokens", perKey: 1_041, total: 10_000_000 })).ok;
  return { w, key, gateway, gatewayRun, run, used };
}

const frames = (text: string) => text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).filter((data) => data !== "[DONE]").map((data) => JSON.parse(data) as Record<string, unknown>);

const chat = (stream: boolean, extra: Record<string, unknown> = {}) => ({ model: "later-dog", stream, messages: [{ role: "user", content: "hello" }], ...extra });

describe("the included AI", () => {
  it("answers a trial's chat with Grok through the AI Gateway on the included model, and counts its tokens", async () => {
    const { w, key, gateway, gatewayRun, used } = await ai();
    const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(false, { api_key: "x", n: 5, max_tokens: 900_000 }) }));
    expect(response.status).toBe(200);
    expect((await body(response)).choices[0].message.content).toBe("Hi");
    expect(gateway).toHaveBeenCalledWith("default");
    const sent = gatewayRun.mock.calls[0]![0] as { provider: string; endpoint: string; headers: Record<string, unknown>; query: Record<string, unknown> };
    expect(sent).toMatchObject({ provider: "grok", endpoint: "v1/chat/completions", headers: { Authorization: "Bearer xai-test", "cf-aig-collect-log": false } });
    expect(sent.query).toEqual({ model: GROK_DEFAULT_MODEL, stream: false, messages: chat(false).messages, max_tokens: 32_000 });
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
    const bare = await world();
    siteverify();
    const bareKey = trialKey("b");
    expect((await startTrial(bare, bareKey)).status).toBe(200);
    expect((await bare.fetch(apiRequest("POST", "/v1/ai/chat/completions", bareKey, { body: chat(false) }))).status).toBe(503);
  });

  it("answers on Workers AI without an xAI key, with thinking off and only the fields it allows", async () => {
    const { w, key, gatewayRun, run, used } = await ai({});
    const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(false, { api_key: "x", tools: [{ type: "function", function: { name: "f" } }] }) }));
    expect(response.status).toBe(200);
    expect((await body(response)).choices[0].message.content).toBe("Hi");
    expect(gatewayRun).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(AI_WORKERS_MODEL, { stream: false, messages: chat(false).messages, tools: [{ type: "function", function: { name: "f" } }], max_tokens: 32_000, chat_template_kwargs: { thinking: false } }, { gateway: { id: "default", collectLog: false } });
    expect(await used()).toBe(true);
  });

  it("turns the Workers AI stream into plain OpenAI chunks with one final usage, and charges it", async () => {
    const { w, key, used } = await ai({});
    const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(true) }));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const sent = frames(text);
    expect(sent.map((frame) => ("usage" in frame) || ("p" in frame))).toEqual([false, false, true]);
    expect(sent[1]).toMatchObject({ choices: [{ delta: { content: "Hi" } }] });
    expect(sent[2]).toEqual({ id: "c1", created: 1, model: AI_WORKERS_MODEL, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 } });
    await Promise.all(w.background);
    expect(await used()).toBe(true);
    await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(false) }));
    expect(await used()).toBe(false);
  });

  it("falls back to Workers AI when xAI does not answer", async () => {
    const { w, key, gatewayRun, run } = await ai(GROK_FIRST, "down");
    const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(false) }));
    expect(response.status).toBe(200);
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("asks Workers AI first when both are set up, and xAI only when Workers AI fails", async () => {
    const both = await ai({ XAI_API_KEY: "xai-test" });
    expect((await both.w.fetch(apiRequest("POST", "/v1/ai/chat/completions", both.key, { body: chat(false) }))).status).toBe(200);
    expect(both.run).toHaveBeenCalledTimes(1);
    expect(both.gatewayRun).not.toHaveBeenCalled();
    const down = await ai({ XAI_API_KEY: "xai-test" }, "ok", "down");
    const response = await down.w.fetch(apiRequest("POST", "/v1/ai/chat/completions", down.key, { body: chat(false) }));
    expect(response.status).toBe(200);
    expect(down.gatewayRun).toHaveBeenCalledTimes(1);
    const none = await ai({}, "ok", "down");
    const failed = await none.w.fetch(apiRequest("POST", "/v1/ai/chat/completions", none.key, { body: chat(true) }));
    expect(failed.status).toBe(502);
    expect(await none.used()).toBe(true);
  });

  it("asks xAI first when the person picked a Grok model, on that model, and moves a retired Grok to Grok 4.7", async () => {
    const { w, key, gatewayRun, run } = await ai({ XAI_API_KEY: "xai-test" });
    const asked = async (model: string) => {
      expect((await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(false, { model }) }))).status).toBe(200);
      return (gatewayRun.mock.calls.at(-1)![0] as unknown as { query: { model: string } }).query.model;
    };
    expect(await asked("grok-4.6")).toBe("grok-4.6");
    expect(await asked("grok-4.7")).toBe("grok-4.7");
    expect(await asked("grok-4.3")).toBe("grok-4.7");
    expect(await asked("grok-9-unlisted")).toBe("grok-4.7");
    expect(gatewayRun).toHaveBeenCalledTimes(4);
    expect(run).not.toHaveBeenCalled();
  });

  it("follows TRIAL_GROK_MODEL for a Grok request that names no included model", async () => {
    const { w, key, gatewayRun } = await ai({ XAI_API_KEY: "xai-test", TRIAL_GROK_MODEL: "grok-4.6" });
    expect((await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(false, { model: "grok-4.3" }) }))).status).toBe(200);
    expect((gatewayRun.mock.calls[0]![0] as unknown as { query: { model: string } }).query.model).toBe("grok-4.6");
  });

  it("moves on when an answer opens with an error, even inside a 200 stream", async () => {
    for (const stream of [true, false]) {
      const { w, key, gatewayRun, run } = await ai(GROK_FIRST, "busy");
      const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: chat(stream) }));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"Hi"');
      expect(gatewayRun).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("passes a good stream through byte for byte, and swaps any provider error text for a plain one", async () => {
    const raw = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
    const kept = await usableStream(new Response(raw).body!);
    expect(await new Response(kept).text()).toBe(raw);
    expect(await usableStream(new Response("").body!)).toBeNull();
    const late = await new Response(plainErrors(sse([{ choices: [{ delta: { content: "Hi" } }] }, XAI_ERROR]))).text();
    expect(late).not.toContain("service tier");
    expect(late).toContain(AI_BUSY);
    expect(late).toContain('"content":"Hi"');
    const workers = await new Response(openAiStream(workersSse([KIMI_STREAM[1], { error: "upstream exploded at node 7" }]))).text();
    expect(workers).not.toContain("node 7");
    expect(workers).toContain(AI_BUSY);
  });

  it("adds up per-chunk usage when a stream never sends its total", async () => {
    const text = await new Response(openAiStream(workersSse(KIMI_STREAM.slice(0, 3)))).text();
    expect(frames(text).at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 2, total_tokens: 902 } });
    expect(text.match(/\[DONE\]/g)).toHaveLength(1);
  });

  it("reads token counts from answers and streams", async () => {
    expect(tokensOf({ total_tokens: 12 })).toBe(12);
    expect(tokensOf({ prompt_tokens: 10, completion_tokens: 5 })).toBe(15);
    expect(tokensOf(undefined)).toBe(0);
    expect(await streamedTokens(sse([{ choices: [] }, { usage: { total_tokens: 77 } }]))).toBe(77);
    expect(chatRequest({ messages: [{ role: "user", content: "x" }], stream: true }, "m")).toMatchObject({ ok: true, request: { model: "m", stream: true, stream_options: { include_usage: true } } });
  });
});
