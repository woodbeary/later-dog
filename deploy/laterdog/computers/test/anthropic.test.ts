import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { AI_BUSY, AI_WORKERS_MODEL, chatRequest, streamedTokens, usableStream, type ChatRequest } from "../src/ai";
import { AI_ANTHROPIC_MODEL, ANTHROPIC_TOKENS_TOTAL_PER_DAY, anthropicBudget, anthropicGatewayRequest, chatCompletion, chatCompletionStream, claudeToolId, messagesRequest } from "../src/anthropic";
import { DAY } from "../src/trial";
import { apiRequest, body, siteverify, startTrial, trialKey, world, viaGateway } from "./fakes";

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

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const COMPUTER = "cmp_abcdefghij23";
const ACTION_TOOL = { type: "function", function: { name: "computer_action", description: "Use the mouse.", parameters: { type: "object", properties: { computer_id: { type: "string" }, action: { type: "string" }, x: { type: "integer" }, y: { type: "integer" } }, required: ["computer_id", "action"], additionalProperties: false } } };
const LIST_TOOL = { type: "function", function: { name: "computer_list", description: "List computers.", parameters: { type: "object", properties: {}, additionalProperties: false } } };

const computerTurns = [
  { role: "system", content: "You are Rex." },
  { role: "user", content: "Click the green button." },
  { role: "assistant", content: "", reasoning_content: "Look first.", tool_calls: [{ id: "call_1", type: "function", function: { name: "computer_list", arguments: "" } }] },
  { role: "tool", tool_call_id: "call_1", content: JSON.stringify({ ok: true, result: `[{"id":"${COMPUTER}"}]` }) },
  { role: "assistant", content: "Clicking it.", tool_calls: [{ id: "call_2", type: "function", function: { name: "computer_action", arguments: JSON.stringify({ computer_id: COMPUTER, action: "click", x: 300, y: 230 }) } }, { id: "call_3", type: "function", function: { name: "computer_list", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_2", content: "{\"ok\":true}" },
  { role: "tool", tool_call_id: "call_3", content: "" },
  { role: "user", content: [{ type: "text", text: "Screenshot result from tool call call_2:" }, { type: "image_url", image_url: { url: PNG } }] },
];

const translated = (raw: Record<string, unknown>) => {
  const parsed = chatRequest({ messages: computerTurns, ...raw }, "later-dog");
  if (!parsed.ok) throw new Error("bad request");
  return messagesRequest(parsed.request, AI_ANTHROPIC_MODEL);
};

const sseBody = (events: unknown[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder();
    for (const event of events) controller.enqueue(encoder.encode(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`));
    controller.close();
  },
});

const HAIKU_STREAM = [
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: AI_ANTHROPIC_MODEL, content: [], usage: { input_tokens: 600, cache_creation_input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "ping" },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Clicking" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "computer_action", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"computer_id\":\"cmp_abcdefghij23\"," } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"action\":\"click\",\"x\":300,\"y\":230}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 100 } },
  { type: "message_stop" },
];

const HAIKU_ANSWER = {
  id: "msg_2",
  type: "message",
  role: "assistant",
  model: AI_ANTHROPIC_MODEL,
  content: [{ type: "text", text: "Clicking " }, { type: "text", text: "it." }, { type: "tool_use", id: "toolu_2", name: "computer_action", input: { computer_id: COMPUTER, action: "click", x: 300, y: 230 } }],
  stop_reason: "tool_use",
  usage: { input_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 10, output_tokens: 2 },
};

const frames = (text: string) => text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).filter((data) => data !== "[DONE]").map((data) => JSON.parse(data) as Record<string, any>);

describe("the Claude request", () => {
  it("turns an OpenAI tool and screenshot conversation into one Messages request with thinking off and the prompt cached", () => {
    const request = translated({ tools: [ACTION_TOOL, LIST_TOOL], temperature: 0.2, top_p: 0.5, seed: 7, max_tokens: 900 });
    expect(request).toEqual({
      model: AI_ANTHROPIC_MODEL,
      max_tokens: 900,
      stream: false,
      thinking: { type: "disabled" },
      cache_control: { type: "ephemeral" },
      system: "You are Rex.",
      tools: [
        { name: "computer_action", description: "Use the mouse.", input_schema: ACTION_TOOL.function.parameters },
        { name: "computer_list", description: "List computers.", input_schema: LIST_TOOL.function.parameters },
      ],
      tool_choice: { type: "auto" },
      messages: [
        { role: "user", content: [{ type: "text", text: "Click the green button." }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "computer_list", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: JSON.stringify({ ok: true, result: `[{"id":"${COMPUTER}"}]` }) }] }] },
        { role: "assistant", content: [{ type: "text", text: "Clicking it." }, { type: "tool_use", id: "call_2", name: "computer_action", input: { computer_id: COMPUTER, action: "click", x: 300, y: 230 } }, { type: "tool_use", id: "call_3", name: "computer_list", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "{\"ok\":true}" }] },
            { type: "tool_result", tool_use_id: "call_3" },
            { type: "text", text: "Screenshot result from tool call call_2:" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
          ],
        },
      ],
    });
  });

  it("maps tool choice, single tool calls, stop words, JSON schemas and effort", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const request = translated({ tools: [ACTION_TOOL], tool_choice: { type: "function", function: { name: "computer_action" } }, parallel_tool_calls: false, stop: "END", response_format: { type: "json_schema", json_schema: { name: "r", schema } }, reasoning_effort: "minimal", stream: true });
    expect(request).toMatchObject({ stream: true, tool_choice: { type: "tool", name: "computer_action", disable_parallel_tool_use: true }, stop_sequences: ["END"], output_config: { format: { type: "json_schema", schema }, effort: "low" } });
    expect(translated({ tools: [ACTION_TOOL], tool_choice: "required" })).toMatchObject({ tool_choice: { type: "any" } });
    expect(translated({ tools: [ACTION_TOOL], tool_choice: "none" })).toMatchObject({ tool_choice: { type: "none" } });
    expect(translated({ tool_choice: "required" })).not.toHaveProperty("tool_choice");
    expect(translated({ response_format: { type: "text" }, reasoning_effort: "xhigh" })).not.toHaveProperty("output_config");
    expect(translated({ reasoning_effort: "constructor" })).not.toHaveProperty("output_config");
    expect(translated({ reasoning_effort: "__proto__" })).not.toHaveProperty("output_config");
  });

  it("gives tool-call ids Kimi wrote a form Claude accepts, the same on the call and on its result", () => {
    const kimiCall = (id: string) => ({ id, type: "function", function: { name: "computer_list", arguments: "{}" } });
    const history = [
      { role: "user", content: "Which computers do I have?" },
      { role: "assistant", content: null, tool_calls: [kimiCall("functions.computer_list:0"), kimiCall("functions:computer.list_0"), kimiCall("call_9")] },
      { role: "tool", tool_call_id: "functions.computer_list:0", content: "[]" },
      { role: "tool", tool_call_id: "functions:computer.list_0", content: "[]" },
      { role: "tool", tool_call_id: "call_9", content: "[]" },
    ];
    const request = messagesRequest({ model: "m", stream: false, max_tokens: 10, messages: history } as ChatRequest, AI_ANTHROPIC_MODEL)!;
    const uses = request.messages[1]!.content.map((block) => block.id);
    const results = request.messages[2]!.content.map((block) => block.tool_use_id);
    expect(results).toEqual(uses);
    for (const id of uses) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Set(uses).size).toBe(3);
    expect(uses[0]).toMatch(/^functions_computer_list_0_[a-z0-9]+$/);
    expect(uses[2]).toBe("call_9");
    expect(claudeToolId("functions.computer_list:0")).toBe(uses[0]);
    expect(claudeToolId("toolu_01A-b")).toBe("toolu_01A-b");
  });

  it("leaves to Kimi what it cannot carry over faithfully", () => {
    const plain = (messages: unknown[], extra: Record<string, unknown> = {}) => messagesRequest({ model: "m", stream: false, max_tokens: 10, messages, ...extra } as ChatRequest, AI_ANTHROPIC_MODEL);
    const hello = { role: "user", content: "hello" };
    expect(plain([hello])).not.toBeNull();
    expect(plain([hello, { role: "assistant", content: "Sure, " }])).toBeNull();
    expect(plain([{ role: "assistant", content: "Hi" }, hello])).toBeNull();
    expect(plain([hello, { role: "assistant", content: "Hi" }, { role: "system", content: "Be brief." }, hello])).toBeNull();
    expect(plain([{ role: "system", content: [{ type: "image_url", image_url: { url: PNG } }] }, hello])).toBeNull();
    expect(plain([hello, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{oops" } }] }, { role: "tool", tool_call_id: "c", content: "x" }])).toBeNull();
    expect(plain([hello, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "[1]" } }] }, { role: "tool", tool_call_id: "c", content: "x" }])).toBeNull();
    expect(plain([hello, { role: "tool", content: "x" }])).toBeNull();
    expect(plain([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }])).toBeNull();
    expect(plain([hello], { tools: [{ type: "web_search" }] })).toBeNull();
    expect(plain([hello], { response_format: { type: "json_object" } })).toBeNull();
    expect(plain([hello], { stop: [1] })).toBeNull();
    expect(plain([hello], { tools: [LIST_TOOL], tool_choice: "sometimes" })).toBeNull();
    expect(plain([hello], { tools: [{ type: "function", function: { name: "mcp.files:read" } }] })).toBeNull();
    expect(plain([hello, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "mcp.files:read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "x" }])).toBeNull();
  });
});

describe("the Claude answer", () => {
  it("reads as an OpenAI chat completion with tool calls and every prompt token counted", () => {
    expect(chatCompletion(HAIKU_ANSWER)).toMatchObject({
      id: "msg_2",
      object: "chat.completion",
      model: AI_ANTHROPIC_MODEL,
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "Clicking it.", tool_calls: [{ id: "toolu_2", type: "function", function: { name: "computer_action", arguments: JSON.stringify({ computer_id: COMPUTER, action: "click", x: 300, y: 230 }) } }] } }],
      usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42, prompt_tokens_details: { cached_tokens: 10 } },
    });
    expect(chatCompletion({ ...HAIKU_ANSWER, content: [{ type: "text", text: "Hi" }], stop_reason: "max_tokens" })).toMatchObject({ choices: [{ finish_reason: "length", message: { content: "Hi" } }] });
    expect(chatCompletion({ ...HAIKU_ANSWER, stop_reason: "refusal" })).toBeNull();
    expect(chatCompletion({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).toBeNull();
  });

  it("streams as OpenAI chunks: text, tool call pieces, the finish reason and one final usage", async () => {
    const text = await new Response(chatCompletionStream(sseBody(HAIKU_STREAM))).text();
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(text.match(/\[DONE\]/g)).toHaveLength(1);
    const sent = frames(text);
    expect(sent.map((frame) => frame.choices.length ? frame.choices[0].delta : "usage")).toEqual([
      { role: "assistant", content: "Clicking" },
      { tool_calls: [{ index: 0, id: "toolu_1", type: "function", function: { name: "computer_action", arguments: "" } }] },
      { tool_calls: [{ index: 0, function: { arguments: "{\"computer_id\":\"cmp_abcdefghij23\"," } }] },
      { tool_calls: [{ index: 0, function: { arguments: "\"action\":\"click\",\"x\":300,\"y\":230}" } }] },
      {},
      "usage",
    ]);
    expect(sent[0]).toMatchObject({ id: "msg_1", model: AI_ANTHROPIC_MODEL, object: "chat.completion.chunk" });
    expect(sent[4]!.choices[0].finish_reason).toBe("tool_calls");
    expect(sent[5]).toMatchObject({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000, prompt_tokens_details: { cached_tokens: 200 } } });
    expect(await streamedTokens(chatCompletionStream(sseBody(HAIKU_STREAM)))).toBe(1000);
  });

  it("streams a tool call Claude gave no input as empty JSON arguments", async () => {
    const noInput = [
      HAIKU_STREAM[0],
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_3", name: "computer_list", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    const sent = frames(await new Response(chatCompletionStream(sseBody(noInput))).text());
    expect(sent.slice(0, 2).map((frame) => frame.choices[0].delta)).toEqual([
      { role: "assistant", tool_calls: [{ index: 0, id: "toolu_3", type: "function", function: { name: "computer_list", arguments: "" } }] },
      { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
    ]);
  });

  it("opens with an error when Claude refuses or fails before saying anything, and hides provider error text", async () => {
    const refused = [HAIKU_STREAM[0], { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 0 } }, { type: "message_stop" }];
    expect(await usableStream(chatCompletionStream(sseBody(refused)))).toBeNull();
    expect(await usableStream(chatCompletionStream(sseBody([{ type: "error", error: { type: "overloaded_error", message: "Overloaded at node 7" } }])))).toBeNull();
    expect(await usableStream(chatCompletionStream(sseBody([])))).toBeNull();
    const late = await new Response(chatCompletionStream(sseBody([...HAIKU_STREAM.slice(0, 4), { type: "error", error: { type: "overloaded_error", message: "Overloaded at node 7" } }]))).text();
    expect(late).not.toContain("node 7");
    expect(late).toContain(AI_BUSY);
    expect(late).toContain('"content":"Clicking"');
    const cut = await new Response(chatCompletionStream(sseBody([...HAIKU_STREAM.slice(0, 4), { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 3 } }, { type: "message_stop" }]))).text();
    expect(frames(cut).at(-2)!.choices[0].finish_reason).toBe("content_filter");
  });
});

type Upstream = "ok" | "down" | "refuses";

async function service(vars: Record<string, string>, claude: Upstream = "ok") {
  const gatewayRun = vi.fn(async (request: { provider: string; query: { stream?: boolean } }) => {
    if (request.provider === "grok") return Response.json({ choices: [{ message: { role: "assistant", content: "Grok" } }], usage: { total_tokens: 5 } });
    if (claude === "down") return new Response("{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}", { status: 401 });
    if (request.query.stream) {
      const events = claude === "refuses" ? [HAIKU_STREAM[0], { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 0 } }, { type: "message_stop" }] : HAIKU_STREAM;
      return new Response(sseBody(events), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json(claude === "refuses" ? { ...HAIKU_ANSWER, stop_reason: "refusal", content: [] } : HAIKU_ANSWER);
  });
  const gateway = vi.fn(() => ({ run: gatewayRun }));
  const run = vi.fn(async () => ({ id: "k", object: "chat.completion", model: AI_WORKERS_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "Kimi" } }], usage: { total_tokens: 7 } }));
  const w = await world({ AI: { run, gateway }, ...vars } as unknown as Record<string, string>);
  siteverify();
  const key = trialKey("h");
  expect((await startTrial(w, key)).status).toBe(200);
  const keySha256 = await sha256Hex(key);
  const registry = w.trials.instances.get("trials") as unknown as { ctx: DurableObjectState };
  const usedOf = (kind: string) => registry.ctx.storage.sql.exec<{ used: number }>("SELECT used FROM usage WHERE key_sha256 = ? AND kind = ?", keySha256, kind).toArray()[0]?.used ?? 0;
  const used = () => usedOf("ai_tokens");
  const claudeCalls = () => gatewayRun.mock.calls.filter(([request]) => request.provider === "anthropic");
  return { w, key, gatewayRun, run, used, usedOf, claudeCalls };
}

const ask = (stream: boolean, extra: Record<string, unknown> = {}) => ({ model: "kimi-k2.6", stream, messages: computerTurns, tools: [ACTION_TOOL, LIST_TOOL], ...extra });

describe("Claude Haiku first", () => {
  it("is never asked while ANTHROPIC_FIRST is off, so Kimi keeps answering as today", async () => {
    for (const flag of [{}, { ANTHROPIC_FIRST: "0" }, { ANTHROPIC_FIRST: "true" }] as Record<string, string>[]) {
      const { w, key, run, claudeCalls } = await service(flag);
      const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: ask(false) }));
      expect((await body(response)).choices[0].message.content).toBe("Kimi");
      expect(claudeCalls()).toHaveLength(0);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("answers first through the AI Gateway's Anthropic endpoint with the gateway's stored key, and charges its tokens", async () => {
    const { w, key, run, gatewayRun, used, usedOf } = await service({ ANTHROPIC_FIRST: "1", XAI_API_KEY: "xai-test" });
    const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: ask(false, { temperature: 0 }) }));
    expect(response.status).toBe(200);
    expect((await body(response)).choices[0]).toMatchObject({ finish_reason: "tool_calls", message: { content: "Clicking it.", tool_calls: [{ function: { name: "computer_action" } }] } });
    expect(run).not.toHaveBeenCalled();
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    const sent = gatewayRun.mock.calls[0]![0] as unknown as { provider: string; endpoint: string; headers: Record<string, unknown>; query: Record<string, unknown> };
    expect(sent).toMatchObject({ provider: "anthropic", endpoint: "v1/messages", headers: { "anthropic-version": "2023-06-01", "cf-aig-collect-log": false, "cf-aig-no-wholesale": true, "cf-aig-request-timeout": 120_000, "cf-aig-metadata": JSON.stringify((await viaGateway(key)).gateway.metadata) } });
    expect(Object.keys(sent.headers).map((name) => name.toLowerCase())).not.toEqual(expect.arrayContaining(["authorization"]));
    expect(Object.keys(sent.headers).map((name) => name.toLowerCase())).not.toContain("x-api-key");
    expect(sent.query).toMatchObject({ model: AI_ANTHROPIC_MODEL, stream: false, max_tokens: 8_000, thinking: { type: "disabled" } });
    expect(sent.query).not.toHaveProperty("temperature");
    expect(used()).toBe(42);
    expect(usedOf("anthropic_tokens")).toBe(42);
  });

  it("streams Claude's answer as OpenAI chunks and charges what the stream reports", async () => {
    const { w, key, run, used, usedOf, gatewayRun } = await service({ ANTHROPIC_FIRST: "1" });
    const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: ask(true) }));
    expect(gatewayRun.mock.calls[0]![0]).toMatchObject({ headers: { "cf-aig-request-timeout": 20_000, "cf-aig-no-wholesale": true } });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toContain('"content":"Clicking"');
    await Promise.all(w.background);
    expect(run).not.toHaveBeenCalled();
    expect(used()).toBe(1000);
    expect(usedOf("anthropic_tokens")).toBe(1000);
  });

  it("falls back to Kimi when Claude is down, refuses, or gets a request it cannot carry", async () => {
    for (const [claude, stream] of [["down", false], ["refuses", false], ["refuses", true]] as const) {
      const { w, key, run, claudeCalls, used, usedOf } = await service({ ANTHROPIC_FIRST: "1" }, claude);
      const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: ask(stream) }));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Kimi");
      await Promise.all(w.background);
      expect(usedOf("anthropic_tokens")).toBe(0);
      expect(used()).toBe(7);
      expect(claudeCalls()).toHaveLength(1);
      expect(run).toHaveBeenCalledTimes(1);
    }
    const { w, key, run, claudeCalls } = await service({ ANTHROPIC_FIRST: "1" });
    const prefill = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: { model: "kimi-k2.6", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello" }] } }));
    expect((await body(prefill)).choices[0].message.content).toBe("Kimi");
    expect(claudeCalls()).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops asking Claude once its own daily token total is used up, and Kimi answers from the same allowance", async () => {
    expect(anthropicBudget({} as Env)).toMatchObject({ kind: "anthropic_tokens", total: ANTHROPIC_TOKENS_TOTAL_PER_DAY });
    expect(anthropicBudget({ ANTHROPIC_TOKENS_PER_DAY: "0" } as unknown as Env).total).toBe(0);
    expect(anthropicBudget({ ANTHROPIC_TOKENS_PER_DAY: "lots" } as unknown as Env).total).toBe(ANTHROPIC_TOKENS_TOTAL_PER_DAY);
    for (const cap of ["0", "10"]) {
      const { w, key, run, claudeCalls, used, usedOf } = await service({ ANTHROPIC_FIRST: "1", ANTHROPIC_TOKENS_PER_DAY: cap });
      const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: ask(false) }));
      expect((await body(response)).choices[0].message.content).toBe("Kimi");
      expect(claudeCalls()).toHaveLength(0);
      expect(run).toHaveBeenCalledTimes(1);
      expect(used()).toBe(7);
      expect(usedOf("anthropic_tokens")).toBe(0);
    }
    expect(anthropicGatewayRequest(translated({ stream: false })!).headers).toMatchObject({ "cf-aig-no-wholesale": true, "cf-aig-request-timeout": 120_000 });
  });

  it("keeps Grok first when a home key picks a Grok model", async () => {
    const { w, key, run, claudeCalls, gatewayRun } = await service({ ANTHROPIC_FIRST: "1", XAI_API_KEY: "xai-test" });
    await w.trials.named("trials").grantHome({ keySha256: await sha256Hex(key), limitMs: 60_000, windowMs: DAY });
    const response = await w.fetch(apiRequest("POST", "/v1/ai/chat/completions", key, { body: ask(false, { model: "grok-4.3" }) }));
    expect((await body(response)).choices[0].message.content).toBe("Grok");
    expect(gatewayRun).toHaveBeenCalledTimes(1);
    expect(claudeCalls()).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });
});
