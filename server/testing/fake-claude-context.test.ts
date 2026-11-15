import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("fake-claude-cli.ts", import.meta.url));
const ask = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
const control = (id: string, detail = "full") => `${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "get_context_usage", detail } })}\n`;

let engine: ChildProcessWithoutNullStreams | null = null;
let printed = "";

function start(mode?: string, follow = false) {
  const { FAKE_CLAUDE_TOOL_CALLS: _calls, FAKE_CLAUDE_CONTEXT: _mode, FAKE_CLAUDE_CONTEXT_FOLLOWS_TURNS: _follow, ...inherited } = process.env;
  engine = spawn(process.execPath, ["--experimental-strip-types", CLI, "-p", "--output-format", "stream-json", "--input-format", "stream-json"], {
    env: { ...inherited, ...(mode ? { FAKE_CLAUDE_CONTEXT: mode } : {}), ...(follow ? { FAKE_CLAUDE_CONTEXT_FOLLOWS_TURNS: "1" } : {}) },
  });
  printed = "";
  engine.stdout.on("data", (chunk) => { printed += chunk; });
  return engine;
}

const lines = () => printed.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; response?: { request_id?: string; subtype?: string; error?: string; response?: any } });
const answer = (id: string) => lines().find((line) => line.type === "control_response" && line.response?.request_id === id)?.response;
const requestSizes = () => lines().filter((line) => line.type === "assistant").map((line: any) => line.message.usage.input_tokens + line.message.usage.cache_read_input_tokens + (line.message.usage.cache_creation_input_tokens ?? 0));
const results = () => lines().filter((line) => line.type === "result").length;

afterEach(async () => {
  if (engine && engine.exitCode === null && engine.signalCode === null) {
    const gone = once(engine, "exit");
    engine.kill("SIGKILL");
    await gone;
  }
  engine = null;
});

describe("the fake engine answers the context request in its three ways", () => {
  it("answers with a breakdown, and the question never becomes a turn", async () => {
    const child = start();
    child.stdin.write(control("c1"));
    await expect.poll(() => answer("c1"), { timeout: 10_000 }).toBeDefined();
    expect(answer("c1")).toMatchObject({ subtype: "success", response: { maxTokens: 200_000, totalTokens: expect.any(Number) } });
    expect(results()).toBe(0);
    child.stdin.write(ask("hello"));
    await expect.poll(results, { timeout: 10_000 }).toBe(1);
    child.stdin.write(control("c2"));
    await expect.poll(() => answer("c2"), { timeout: 10_000 }).toBeDefined();
    expect(answer("c2")!.response.totalTokens).toBeGreaterThan(answer("c1")!.response.totalTokens);
    expect(results()).toBe(1);
  });

  it("answers a summary with a fixed rough total and a full count with the size of the turn's real request", async () => {
    const child = start(undefined, true);
    child.stdin.write(control("s1", "summary") + control("f1"));
    await expect.poll(() => answer("f1"), { timeout: 10_000 }).toBeDefined();
    child.stdin.write(ask("hello"));
    await expect.poll(results, { timeout: 10_000 }).toBe(1);
    child.stdin.write(control("s2", "summary") + control("f2"));
    await expect.poll(() => answer("f2"), { timeout: 10_000 }).toBeDefined();
    const ids = (id: string) => answer(id)!.response.categories.map((category: { id: string }) => category.id);
    expect(answer("s2")!.response.totalTokens).toBe(answer("s1")!.response.totalTokens);
    expect(ids("s2")).not.toContain("messages");
    expect(ids("f2")).toContain("messages");
    expect(answer("f2")!.response.totalTokens).toBeGreaterThan(answer("f1")!.response.totalTokens);
    expect(answer("f2")!.response.totalTokens).toBe(requestSizes().at(-1));
    expect(answer("s2")!.response.totalTokens).not.toBe(answer("f2")!.response.totalTokens);
    const messages = answer("f2")!.response.categories.find((category: { id: string }) => category.id === "messages").tokens;
    expect(answer("f2")!.response.totalTokens - messages).toBe(answer("f1")!.response.totalTokens - answer("f1")!.response.categories.find((category: { id: string }) => category.id === "messages").tokens);
  });

  it("refuses the request like an engine that predates it", async () => {
    const child = start("unknown");
    child.stdin.write(control("c1"));
    await expect.poll(() => answer("c1"), { timeout: 10_000 }).toBeDefined();
    expect(answer("c1")).toEqual({ subtype: "error", request_id: "c1", error: "Unsupported control request subtype: get_context_usage" });
  });

  it("says there is no turn yet, then answers once a turn has run", async () => {
    const child = start("no-turn");
    child.stdin.write(control("c1"));
    await expect.poll(() => answer("c1"), { timeout: 10_000 }).toBeDefined();
    expect(answer("c1")).toEqual({ subtype: "error", request_id: "c1", error: "getContextUsage: no turn received yet" });
    child.stdin.write(ask("hello"));
    await expect.poll(results, { timeout: 10_000 }).toBe(1);
    child.stdin.write(control("c2"));
    await expect.poll(() => answer("c2"), { timeout: 10_000 }).toBeDefined();
    expect(answer("c2")!.subtype).toBe("success");
  });
});
