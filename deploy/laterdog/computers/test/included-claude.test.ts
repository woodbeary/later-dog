import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { AI_BUSY, AI_WORKERS_MODEL, CLAUDE_DEFAULT_MODEL, CLAUDE_TOKENS_PER_DAY, GROK_DEFAULT_MODEL, billedTokens, chatUpstreams, modelCap, openAiRequest } from "../src/ai";
import { CLAUDE_CONTINUE, CLAUDE_EFFORT, CLAUDE_OPENING, CLAUDE_THINKING, claudeBody, claudeChunks, claudeCompletion, claudeMessages } from "../src/claude";
import { apiRequest, body, siteverify, startTrial, trialKey, world } from "./fakes";

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

const anthropicSse = (events: Record<string, unknown>[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder();
    for (const event of events) controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
    controller.close();
  },
});

const openAiSse = (chunks: unknown[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder();
    for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  },
});

const CLAUDE_MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: CLAUDE_DEFAULT_MODEL,
  content: [{ type: "text", text: "Hi from Claude" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 12 },
};

const CLAUDE_STREAM = [
  { type: "message_start", message: { id: "msg_2", type: "message", role: "assistant", model: CLAUDE_DEFAULT_MODEL, content: [], usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 1, service_tier: "standard" } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "ping" },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "look", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"q\":" } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"x\"}" } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 50 } },
  { type: "message_stop" },
];

const OVERLOADED = { type: "error", error: { type: "overloaded_error", message: "Overloaded, details at https://status.example" } };

type Claude = "ok" | "down" | "overloaded";

async function setup(vars: Record<string, string> = { ANTHROPIC_API_KEY: "sk-ant-test" }, claude: Claude = "ok") {
  const gatewayRun = vi.fn(async (request: { provider: string; query: { stream?: boolean } }) => {
    if (request.provider === "anthropic") {
      if (claude === "down") return new Response("{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}", { status: 529 });
      if (claude === "overloaded") return new Response(anthropicSse([OVERLOADED]), { headers: { "content-type": "text/event-stream" } });
      return request.query.stream ? new Response(anthropicSse(CLAUDE_STREAM), { headers: { "content-type": "text/event-stream" } }) : Response.json(CLAUDE_MESSAGE);
    }
    return request.query.stream
      ? new Response(openAiSse([{ choices: [{ delta: { content: "Hi from Grok" } }] }, { choices: [], usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 } }]), { headers: { "content-type": "text/event-stream" } })
      : Response.json({ choices: [{ message: { role: "assistant", content: "Hi from Grok" } }], usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 } });
  });
  const gateway = vi.fn(() => ({ run: gatewayRun }));
  const run = vi.fn(async (_model: string, _input: Record<string, unknown>) => ({
    id: "c2", object: "chat.completion", model: AI_WORKERS_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "Hi from Kimi" } }], usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 },
  }));
  const w = await world({ AI: { run, gateway }, ...vars } as unknown as Record<string, string>);
  siteverify();
  const key = trialKey("c");
  expect((await startTrial(w, key)).status).toBe(200);
  const registry = w.trials.named("trials");
  const usedExactly = async (kind: "ai_tokens" | "claude_tokens" | "grok_tokens", amount: number) => {
    const keySha256 = await sha256Hex(key);
    const below = await registry.usageLeft({ keySha256, kind, perKey: amount, total: 1e12 });
    const above = await registry.usageLeft({ keySha256, kind, perKey: amount + 1, total: 1e12 });
    return !below.ok && above.ok;
  };
  const send = (payload: Record<string, unknown>) => w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: payload }));
  return { w, key, gateway, gatewayRun, run, usedExactly, send, registry };
}

const ask = (stream: boolean, extra: Record<string, unknown> = {}) => ({ model: CLAUDE_DEFAULT_MODEL, stream, messages: [{ role: "system", content: "You are Biscuit." }, { role: "user", content: "hello" }], ...extra });

const frames = (text: string) => text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).filter((data) => data !== "[DONE]").map((data) => JSON.parse(data) as Record<string, any>);

describe("the included Claude", () => {
  it("answers Claude Sonnet 5 through the AI Gateway's anthropic provider and counts its own allowance", async () => {
    const { gateway, gatewayRun, run, usedExactly, send } = await setup();
    const response = await send(ask(false, { temperature: 0.2, top_p: 0.9, seed: 4 }));
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(answer).toMatchObject({ object: "chat.completion", model: CLAUDE_DEFAULT_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "Hi from Claude" }, finish_reason: "stop" }] });
    expect(answer.usage).toEqual({ prompt_tokens: 30, completion_tokens: 12, total_tokens: 42, prompt_tokens_details: { cached_tokens: 0 } });
    expect(gateway).toHaveBeenCalledWith("default");
    expect(run).not.toHaveBeenCalled();
    const sent = gatewayRun.mock.calls[0]![0] as unknown as { provider: string; endpoint: string; headers: Record<string, unknown>; query: Record<string, unknown> };
    expect(sent).toMatchObject({ provider: "anthropic", endpoint: "v1/messages", headers: { "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01", "cf-aig-collect-log": false } });
    expect(sent.query).toEqual({
      model: CLAUDE_DEFAULT_MODEL,
      max_tokens: 16_000,
      system: "You are Biscuit.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      output_config: { effort: CLAUDE_EFFORT },
      cache_control: { type: "ephemeral" },
      stream: false,
    });
    expect(await usedExactly("claude_tokens", 42)).toBe(true);
    expect(await usedExactly("ai_tokens", 42)).toBe(true);
  });

  it("streams Claude back as OpenAI chunks with its tool calls, its signed thinking and one usage, and charges cache reads at a tenth", async () => {
    const { w, send, usedExactly } = await setup();
    const response = await send(ask(true));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const sent = frames(text);
    expect(sent.map((frame) => frame.choices[0]?.delta ?? null)).toEqual([
      { role: "assistant", content: "" },
      { reasoning_details: [{ type: CLAUDE_THINKING, thinking: "", signature: "sig-abc" }] },
      { content: "Hi" },
      { tool_calls: [{ index: 0, id: "toolu_1", type: "function", function: { name: "look", arguments: "" } }] },
      { tool_calls: [{ index: 0, function: { arguments: "{\"q\":" } }] },
      { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] },
      {},
      null,
    ]);
    expect(sent[6]!.choices[0].finish_reason).toBe("tool_calls");
    expect(sent.every((frame) => frame.id === "msg_2" && frame.model === CLAUDE_DEFAULT_MODEL && frame.object === "chat.completion.chunk")).toBe(true);
    expect(sent[7]!.usage).toEqual({ prompt_tokens: 1300, completion_tokens: 50, total_tokens: 1350, prompt_tokens_details: { cached_tokens: 1000 } });
    await Promise.all(w.background);
    expect(await usedExactly("claude_tokens", 450)).toBe(true);
    expect(await usedExactly("ai_tokens", 450)).toBe(true);
  });

  it("answers on Kimi when no Anthropic key is set, so a trial never breaks", async () => {
    const { gatewayRun, run, send, usedExactly } = await setup({});
    const response = await send(ask(false));
    expect(response.status).toBe(200);
    expect((await body(response)).choices[0].message.content).toBe("Hi from Kimi");
    expect(gatewayRun).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe(AI_WORKERS_MODEL);
    expect(await usedExactly("ai_tokens", 42)).toBe(true);
    expect(await usedExactly("claude_tokens", 0)).toBe(true);
  });

  it("moves on to Kimi when Anthropic refuses, or when its stream opens with an error", async () => {
    for (const [claude, stream] of [["down", false], ["down", true], ["overloaded", true]] as const) {
      const { gatewayRun, run, send } = await setup({ ANTHROPIC_API_KEY: "sk-ant-test" }, claude);
      const response = await send(ask(stream));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("Hi from Kimi");
      expect(text).not.toContain("status.example");
      expect(gatewayRun).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("stops asking Claude once the installation's Claude allowance is used, and keeps the trial going on Kimi", async () => {
    const { gatewayRun, run, send, usedExactly } = await setup({ ANTHROPIC_API_KEY: "sk-ant-test", TRIAL_CLAUDE_TOKENS_PER_DAY: "40" });
    expect((await body(await send(ask(false)))).choices[0].message.content).toBe("Hi from Claude");
    expect((await body(await send(ask(false)))).choices[0].message.content).toBe("Hi from Kimi");
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await usedExactly("claude_tokens", 42)).toBe(true);
    expect(await usedExactly("ai_tokens", 84)).toBe(true);
  });

  it("can switch Claude off with a zero allowance, and holds everyone to the day's Claude total", async () => {
    const off = await setup({ ANTHROPIC_API_KEY: "sk-ant-test", TRIAL_CLAUDE_TOKENS_PER_DAY: "0" });
    expect((await body(await off.send(ask(false)))).choices[0].message.content).toBe("Hi from Kimi");
    expect(off.gatewayRun).not.toHaveBeenCalled();
    const full = await setup({ ANTHROPIC_API_KEY: "sk-ant-test", TRIAL_CLAUDE_TOKENS_TOTAL_PER_DAY: "10" });
    await full.registry.chargeUsage({ keySha256: "someone-else", kind: "claude_tokens", amount: 10 });
    expect((await body(await full.send(ask(false)))).choices[0].message.content).toBe("Hi from Kimi");
    expect(full.gatewayRun).not.toHaveBeenCalled();
  });

  it("holds Grok 4.7 to its own allowance too", async () => {
    const { gatewayRun, run, send, usedExactly } = await setup({ XAI_API_KEY: "xai-test", TRIAL_GROK_TOKENS_PER_DAY: "40" });
    expect((await body(await send(ask(false, { model: "grok-4.7" })))).choices[0].message.content).toBe("Hi from Grok");
    expect(await usedExactly("grok_tokens", 42)).toBe(true);
    expect((await body(await send(ask(false, { model: "grok-4.7" })))).choices[0].message.content).toBe("Hi from Kimi");
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back from Claude to Kimi to Grok, and never sends Claude's signed thinking to another provider", async () => {
    const { gatewayRun, run, send } = await setup({ ANTHROPIC_API_KEY: "sk-ant-test", XAI_API_KEY: "xai-test" }, "down");
    run.mockRejectedValueOnce(new Error("3040: Capacity temporarily exceeded"));
    const history = [
      { role: "user", content: "look for x" },
      { role: "assistant", content: null, tool_calls: [{ id: "toolu_1", type: "function", function: { name: "look", arguments: "{\"q\":\"x\"}" } }], reasoning_details: [{ type: CLAUDE_THINKING, thinking: "", signature: "sig" }] },
      { role: "tool", tool_call_id: "toolu_1", content: "found" },
    ];
    const response = await send({ model: CLAUDE_DEFAULT_MODEL, stream: false, messages: history });
    expect((await body(response)).choices[0].message.content).toBe("Hi from Grok");
    expect(gatewayRun.mock.calls.map((call) => (call[0] as unknown as { provider: string }).provider)).toEqual(["anthropic", "grok"]);
    const grokQuery = (gatewayRun.mock.calls[1]![0] as unknown as { query: { model: string; messages: Record<string, unknown>[] } }).query;
    expect(grokQuery.model).toBe(GROK_DEFAULT_MODEL);
    expect(grokQuery.messages[1]).not.toHaveProperty("reasoning_details");
    expect(run.mock.calls[0]![1].messages).toEqual(grokQuery.messages);
    const claudeQuery = (gatewayRun.mock.calls[0]![0] as unknown as { query: { messages: unknown[] } }).query;
    expect(claudeQuery.messages[1]).toEqual({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "look", input: { q: "x" } }] });
  });
});

describe("which included model answers", () => {
  const all = { claude: true, grok: true };
  it("asks the provider of the model the person picked first", () => {
    expect(chatUpstreams("claude-sonnet-5", all)).toEqual([{ kind: "claude", model: "claude-sonnet-5" }, { kind: "workers", model: AI_WORKERS_MODEL }, { kind: "grok", model: "grok-4.7" }]);
    expect(chatUpstreams("claude-sonnet-5-5", all)[0]).toEqual({ kind: "claude", model: "claude-sonnet-5-5" });
    expect(chatUpstreams("claude-opus-5-5", all)[0]).toEqual({ kind: "claude", model: CLAUDE_DEFAULT_MODEL });
    expect(chatUpstreams("claude-sonnet-5", { ...all, claudeModel: "claude-sonnet-6" })[0]).toEqual({ kind: "claude", model: "claude-sonnet-5" });
    expect(chatUpstreams("claude-anything", { ...all, claudeModel: "claude-sonnet-6" })[0]).toEqual({ kind: "claude", model: "claude-sonnet-6" });
    expect(chatUpstreams("grok-4.6", all)).toEqual([{ kind: "grok", model: "grok-4.6" }, { kind: "workers", model: AI_WORKERS_MODEL }]);
    expect(chatUpstreams("kimi-k2.6", all)).toEqual([{ kind: "workers", model: AI_WORKERS_MODEL }, { kind: "grok", model: "grok-4.7" }]);
  });

  it("leaves out what isn't set up, and follows TRIAL_AI_FIRST when no model is named", () => {
    expect(chatUpstreams("claude-sonnet-5", { claude: false, grok: false })).toEqual([{ kind: "workers", model: AI_WORKERS_MODEL }]);
    expect(chatUpstreams("grok-4.7", { claude: true, grok: false })).toEqual([{ kind: "workers", model: AI_WORKERS_MODEL }]);
    expect(chatUpstreams("later-dog", { ...all, first: "xai" })[0]).toEqual({ kind: "grok", model: "grok-4.7" });
    expect(chatUpstreams("later-dog", { ...all, first: "anthropic" })[0]).toEqual({ kind: "claude", model: CLAUDE_DEFAULT_MODEL });
    expect(chatUpstreams("later-dog", { ...all, workersModel: "@cf/other/model" })[0]).toEqual({ kind: "workers", model: "@cf/other/model" });
  });

  it("gives Claude and Grok their own daily allowances with safe defaults, and Kimi none", () => {
    expect(modelCap({ kind: "claude", model: "m" }, {})).toEqual({ kind: "claude_tokens", perKey: CLAUDE_TOKENS_PER_DAY, total: 10_000_000 });
    expect(modelCap({ kind: "claude", model: "m" }, { TRIAL_CLAUDE_TOKENS_PER_DAY: "nope", TRIAL_CLAUDE_TOKENS_TOTAL_PER_DAY: "5000" })).toEqual({ kind: "claude_tokens", perKey: CLAUDE_TOKENS_PER_DAY, total: 5000 });
    expect(modelCap({ kind: "claude", model: "m" }, { TRIAL_CLAUDE_TOKENS_PER_DAY: "99999999999" })?.perKey).toBe(1_500_000);
    expect(modelCap({ kind: "grok", model: "m" }, {})).toEqual({ kind: "grok_tokens", perKey: 300_000, total: 15_000_000 });
    expect(modelCap({ kind: "workers", model: "m" }, {})).toBeNull();
    expect(billedTokens({ prompt_tokens: 1300, completion_tokens: 50, total_tokens: 1350, prompt_tokens_details: { cached_tokens: 1000 } }, 0.1)).toBe(450);
    expect(billedTokens({ prompt_tokens: 10, completion_tokens: 5 }, 0.1)).toBe(15);
    expect(billedTokens(undefined, 0.1)).toBe(0);
  });
});

describe("turning an OpenAI chat into a Claude request", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("lifts system text, keeps images, and pairs tool calls with their results", () => {
    const { system, turns } = claudeMessages([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: PNG } }, { type: "image_url", image_url: { url: "http://insecure.example/a.png" } }] },
      { role: "assistant", content: "Let me look.", tool_calls: [{ id: "t1", type: "function", function: { name: "screen", arguments: "{}" } }, { id: "t2", type: "function", function: { name: "read", arguments: "not json" } }] },
      { role: "tool", tool_call_id: "t1", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } }] },
      { role: "user", content: "and quickly" },
      { role: "tool", tool_call_id: "t2", content: "" },
      { role: "system", content: [{ type: "text", text: "Use plain words." }] },
    ]);
    expect(system).toBe("Be brief.\n\nUse plain words.");
    expect(turns).toEqual([
      { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] },
      { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "t1", name: "screen", input: {} }, { type: "tool_use", id: "t2", name: "read", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } }] },
        { type: "tool_result", tool_use_id: "t2" },
        { type: "text", text: "and quickly" },
      ] },
    ]);
  });

  it("never starts with the dog or ends on it, and drops empty turns", () => {
    expect(claudeMessages([{ role: "assistant", content: "Woof!" }, { role: "user", content: "" }, { role: "assistant", content: null }]).turns).toEqual([
      { role: "user", content: [{ type: "text", text: CLAUDE_OPENING }] },
      { role: "assistant", content: [{ type: "text", text: "Woof!" }] },
      { role: "user", content: [{ type: "text", text: CLAUDE_CONTINUE }] },
    ]);
    expect(claudeBody({ model: "", stream: false, messages: [{ role: "system", content: "only rules" }] }, CLAUDE_DEFAULT_MODEL)).toBeNull();
  });

  it("maps tools, tool choice, stops and effort, and leaves out sampling settings Claude refuses", () => {
    const request = {
      model: "",
      stream: true,
      max_tokens: 32_000,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "look", description: "Look around", parameters: { type: "object", properties: { q: { type: "string" } } } } }, { type: "function", function: { name: "bare" } }, { type: "function" }],
      parallel_tool_calls: false,
      temperature: 0.3,
      top_p: 0.5,
      stop: "END",
      reasoning_effort: "high",
    };
    expect(claudeBody(request, CLAUDE_DEFAULT_MODEL)).toEqual({
      model: CLAUDE_DEFAULT_MODEL,
      max_tokens: 32_000,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        { name: "look", description: "Look around", input_schema: { type: "object", properties: { q: { type: "string" } } } },
        { name: "bare", input_schema: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      stop_sequences: ["END"],
      output_config: { effort: "high" },
      cache_control: { type: "ephemeral" },
      stream: true,
    });
    expect(claudeBody({ ...request, tool_choice: "none", parallel_tool_calls: undefined, reasoning_effort: "xhigh" }, CLAUDE_DEFAULT_MODEL)).toMatchObject({ tool_choice: { type: "none" }, output_config: { effort: CLAUDE_EFFORT } });
    expect(claudeBody({ ...request, tools: undefined, tool_choice: "none" }, CLAUDE_DEFAULT_MODEL)).not.toHaveProperty("tool_choice");
  });
});

describe("turning Claude's answer into an OpenAI one", () => {
  it("returns tool calls, signed thinking and the stop reason", () => {
    expect(claudeCompletion({
      id: "msg_3",
      type: "message",
      model: CLAUDE_DEFAULT_MODEL,
      content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "redacted_thinking", data: "r" }, { type: "tool_use", id: "t1", name: "look", input: { q: "x" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 3 },
    })).toMatchObject({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "look", arguments: "{\"q\":\"x\"}" } }], reasoning_details: [{ type: CLAUDE_THINKING, thinking: "", signature: "s" }, { type: "anthropic.redacted_thinking", data: "r" }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 35, completion_tokens: 3, total_tokens: 38, prompt_tokens_details: { cached_tokens: 20 } },
    });
    expect(claudeCompletion({ type: "error", error: { type: "overloaded_error" } })).toBeNull();
    expect(claudeCompletion({ type: "message", content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens" })).toMatchObject({ choices: [{ message: { content: "cut" }, finish_reason: "length" }] });
  });

  it("ends a stream that breaks off with a plain error after its usage, never the provider's text", async () => {
    const text = await new Response(claudeChunks(anthropicSse(CLAUDE_STREAM.slice(0, 8)))).text();
    const sent = frames(text);
    expect(sent.at(-2)!.usage).toMatchObject({ prompt_tokens: 1300, completion_tokens: 1 });
    expect(sent.at(-1)).toEqual({ error: { message: AI_BUSY, type: "server_error", code: "upstream_failed" } });
    expect(text.match(/\[DONE\]/g)).toHaveLength(1);
    const late = await new Response(claudeChunks(anthropicSse([...CLAUDE_STREAM.slice(0, 8), OVERLOADED]))).text();
    expect(late).not.toContain("status.example");
    expect(frames(late).filter((frame) => frame.error)).toHaveLength(1);
  });

  it("strips Claude's signed thinking before a chat goes to another provider", () => {
    const request = { model: "x", stream: false, messages: [{ role: "assistant", content: "a", reasoning_details: [{ type: CLAUDE_THINKING }] }, { role: "user", content: "b" }] };
    expect(openAiRequest(request, "grok-4.7")).toEqual({ model: "grok-4.7", stream: false, messages: [{ role: "assistant", content: "a" }, { role: "user", content: "b" }] });
    expect(request.messages[0]).toHaveProperty("reasoning_details");
  });
});
