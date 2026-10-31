import { describe, expect, it } from "vitest";
import {
  anthropicMessages, ANTHROPIC_VERSION, COMPUTER_TOOLSET_TYPE, COMPUTER_USE_MODEL, fixtureMessagesUrl, MESSAGES_URL, messagesBody, parseReply,
} from "./computer-use-anthropic.ts";

const KEY = `sk-ant-api03-${"f".repeat(40)}`;
const REQUEST = { system: "fixture system", messages: [{ role: "user" as const, content: [{ type: "text", text: "Task: fixture" }] }] };
const ANSWER = {
  id: "msg_fixture", type: "message", role: "assistant", model: COMPUTER_USE_MODEL, stop_reason: "tool_use",
  content: [{ type: "tool_use", id: "toolu_1", name: "screenshot", input: {}, toolset_name: "computer" }],
  usage: { input_tokens: 1400, output_tokens: 90, cache_read_input_tokens: 1200, cache_creation_input_tokens: 64 },
};

function fakeFetch(answers: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("no fixture answer left");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("the request later.dog sends", () => {
  it("pins one model and declares the computer toolset with no name, display size or beta header", () => {
    const body = messagesBody(REQUEST);
    expect(body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "medium" }, system: "fixture system", messages: REQUEST.messages });
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]).toEqual({ type: COMPUTER_TOOLSET_TYPE, configs: { zoom: { enabled: false } } });
    expect(COMPUTER_TOOLSET_TYPE).toBe("computer_toolset_20260801");
    expect(tools[1]).toMatchObject({ name: "request_takeover", strict: true });
    expect(JSON.stringify(body)).not.toMatch(/display_width_px|display_height_px|computer_2025|fallbacks/);
  });

  it("posts to the Messages API with the key in its header and nothing else secret", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: ANSWER }]);
    const answer = await anthropicMessages(KEY, { fetch: impl }).create(REQUEST, new AbortController().signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(MESSAGES_URL);
    expect(calls[0]!.init.headers).toEqual({ "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION, "x-api-key": KEY });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(messagesBody(REQUEST));
    expect(answer).toEqual({ model: COMPUTER_USE_MODEL, stopReason: "tool_use", content: ANSWER.content,
      usage: { inputTokens: 1400, outputTokens: 90, cacheReadTokens: 1200, cacheWriteTokens: 64 } });
  });
});

describe("answers and failures", () => {
  it("retries an overloaded or rate-limited answer once", async () => {
    const slept: number[] = [];
    const { impl, calls } = fakeFetch([{ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }, { status: 200, body: ANSWER }]);
    const api = anthropicMessages(KEY, { fetch: impl, sleep: async (ms) => { slept.push(ms); } });
    expect((await api.create(REQUEST, new AbortController().signal)).stopReason).toBe("tool_use");
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([2000]);
  });

  it("says what the API said, without the key, and does not retry a bad request", async () => {
    const { impl, calls } = fakeFetch([{ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "tools.0: bad" } } }]);
    const failure = await anthropicMessages(KEY, { fetch: impl }).create(REQUEST, new AbortController().signal).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Claude's API answered 400 (invalid_request_error: tools.0: bad).");
    expect((failure as Error).message).not.toContain(KEY);
    expect(calls).toHaveLength(1);
  });

  it("sends real calls only to Claude's API, and a fixture address only on loopback", () => {
    expect(fixtureMessagesUrl(undefined)).toBe(MESSAGES_URL);
    expect(fixtureMessagesUrl("http://127.0.0.1:4120/v1/messages")).toBe("http://127.0.0.1:4120/v1/messages");
    expect(() => fixtureMessagesUrl("https://example.com/v1/messages")).toThrow("loopback fixture");
    expect(() => fixtureMessagesUrl("http://192.168.1.5/v1/messages")).toThrow("loopback fixture");
  });

  it("refuses a key that is not a Claude API key", () => {
    expect(() => anthropicMessages("not-a-key")).toThrow("start with sk-ant-");
  });

  it("refuses an answer it cannot read", () => {
    expect(() => parseReply({ content: [] })).toThrow("could not read");
    expect(parseReply({ ...ANSWER, usage: { input_tokens: 5, output_tokens: 6 } }).usage).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
