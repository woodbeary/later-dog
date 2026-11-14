import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("fake-claude-cli.ts", import.meta.url));
const ask = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
const control = (id: string) => `${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "get_context_usage", detail: "summary" } })}\n`;

let engine: ChildProcessWithoutNullStreams | null = null;
let printed = "";

function start(mode?: string) {
  const { FAKE_CLAUDE_TOOL_CALLS: _calls, FAKE_CLAUDE_CONTEXT: _mode, ...inherited } = process.env;
  engine = spawn(process.execPath, ["--experimental-strip-types", CLI, "-p", "--output-format", "stream-json", "--input-format", "stream-json"], {
    env: { ...inherited, ...(mode ? { FAKE_CLAUDE_CONTEXT: mode } : {}) },
  });
  printed = "";
  engine.stdout.on("data", (chunk) => { printed += chunk; });
  return engine;
}

const lines = () => printed.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; response?: { request_id?: string; subtype?: string; error?: string; response?: any } });
const answer = (id: string) => lines().find((line) => line.type === "control_response" && line.response?.request_id === id)?.response;
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
