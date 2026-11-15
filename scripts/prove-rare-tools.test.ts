import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { answer, PROOF_REPLY } from "../server/testing/proof-agents-server.ts";
import { ALWAYS_LOAD_META, AGENTS_DEFER_RARE_ENV, RARE_AGENT_TOOLS } from "../server/laterdog/tool-loading.ts";
import { calledWithEverythingRequired, launchArgs, prove, readStream } from "./prove-rare-tools.ts";

const STUB_ENGINE = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const argv = process.argv.slice(2);
const at = (flag) => argv[argv.indexOf(flag) + 1];
const prompt = at("-p");
const agents = JSON.parse(readFileSync(at("--mcp-config"), "utf8")).mcpServers.agents;
const server = spawn(agents.command, agents.args, { env: { ...process.env, ...agents.env }, stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let next = 1;
createInterface({ input: server.stdout }).on("line", (line) => { const frame = JSON.parse(line); pending.get(frame.id)?.(frame); });
const rpc = (method, params) => new Promise((done) => { const id = next++; pending.set(id, done); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); });
await rpc("initialize", {});
const { result } = await rpc("tools/list", {});
const deferred = new Set(result.tools.filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === false).map((tool) => tool.name));
const loadedBytes = result.tools.filter((tool) => !deferred.has(tool.name)).reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
const usage = { input_tokens: 3, cache_creation_input_tokens: Math.round(loadedBytes / 4), cache_read_input_tokens: 0, output_tokens: 1 };
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
let request = 0;
const assistant = (content) => out({ type: "assistant", message: { id: "msg-" + ++request, usage, content } });
const want = prompt.includes("555-0100") ? ["send_text", { to: "555-0100", text: "Running ten minutes late." }]
  : prompt.includes("water") ? ["propose_routine", { name: "Plants", instructions: "Remind me to water the plants.", schedule: { kind: "cron", expr: "0 9 * * 1", timeZone: "America/Los_Angeles" } }]
  : null;
out({ type: "system", subtype: "init", model: at("--model") });
if (want) {
  if (deferred.has(want[0])) {
    assistant([{ type: "tool_use", id: "search", name: "ToolSearch", input: { query: "select:mcp__agents__" + want[0] } }]);
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "search", content: "loaded" }] } });
  }
  assistant([{ type: "tool_use", id: "call", name: "mcp__agents__" + want[0], input: want[1] }]);
  const called = await rpc("tools/call", { name: want[0], arguments: want[1] });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", content: called.result.content }] } });
}
assistant([{ type: "text", text: "Done." }]);
out({ type: "result", subtype: "success", is_error: false, result: "Done." });
server.kill();
`;

let scratch = "";
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

describe("the rare-tools proof recipe", () => {
  it("serves later.dog's real tool list, marks rare tools only when asked, and records calls without doing anything", () => {
    scratch = mkdtempSync(join(tmpdir(), "laterdog-proof-server-"));
    const callsFile = join(scratch, "calls.jsonl");
    writeFileSync(callsFile, "");
    const list = (env: Record<string, string>) => (answer({ id: 1, method: "tools/list" }, env) as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> } }).result.tools;
    const marked = (env: Record<string, string>) => list(env).filter((tool) => tool._meta?.[ALWAYS_LOAD_META] === false).map((tool) => tool.name).sort();
    expect(marked({})).toEqual([]);
    expect(marked({ [AGENTS_DEFER_RARE_ENV]: "1" })).toEqual([...RARE_AGENT_TOOLS].sort());
    const reply = answer({ id: 2, method: "tools/call", params: { name: "send_text", arguments: { to: "555-0100", text: "hi" } } }, { LATERDOG_PROOF_CALLS_FILE: callsFile });
    expect(reply).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: PROOF_REPLY }], isError: false } });
    expect(readFileSync(callsFile, "utf8")).toBe(`${JSON.stringify({ name: "send_text", arguments: { to: "555-0100", text: "hi" } })}\n`);
  });

  it("reads the first request's tokens, the searches and the failed calls from the engine's stream", () => {
    const stream = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { id: "a", usage: { input_tokens: 5, cache_creation_input_tokens: 30_000, cache_read_input_tokens: 700 }, content: [{ type: "tool_use", name: "ToolSearch" }] } },
      { type: "assistant", message: { id: "a", usage: { input_tokens: 5 }, content: [{ type: "text" }] } },
      { type: "user", message: { content: [{ type: "tool_result", is_error: true }] } },
      { type: "assistant", message: { id: "b", usage: { input_tokens: 9 }, content: [{ type: "tool_use", name: "mcp__agents__send_text" }] } },
      { type: "result", result: "Sent." },
    ].map((line) => JSON.stringify(line)).join("\n");
    expect(readStream(`${stream}\nnot json\n`)).toEqual({
      firstRequestTokens: 30_705, requests: 2, toolSearches: 1, toolUses: ["ToolSearch", "mcp__agents__send_text"], failedCalls: 1, reply: "Sent.",
    });
  });

  it("counts a rare tool as found only when every required field was filled", () => {
    expect(calledWithEverythingRequired([{ name: "send_text", arguments: { to: "555-0100", text: "late" } }], "send_text")).toBe(true);
    expect(calledWithEverythingRequired([{ name: "send_text", arguments: { to: "555-0100" } }], "send_text")).toBe(false);
    expect(calledWithEverythingRequired([{ name: "send_email", arguments: { to: [], subject: "a", body: "b" } }], "send_email")).toBe(false);
    expect(calledWithEverythingRequired([], "send_text")).toBe(false);
  });

  it("launches the engine with the prompt first and the same isolation flags later.dog uses", () => {
    const args = launchArgs({ prompt: "hi", model: "claude-haiku-5-5", mcpConfig: "/m.json", systemFile: "/s.txt" });
    expect(args.slice(0, 2)).toEqual(["-p", "hi"]);
    for (const flag of ["--strict-mcp-config", "--verbose"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("/s.txt");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(args.at(-1)).toBe("mcp__agents,ToolSearch");
  });

  it("runs every task with the setting off and on and writes a summary, here against a stand-in engine", async () => {
    scratch = mkdtempSync(join(tmpdir(), "laterdog-proof-run-"));
    const engine = join(scratch, "engine.mjs");
    writeFileSync(engine, STUB_ENGINE);
    chmodSync(engine, 0o755);
    const out = join(scratch, "out");
    const runs = await prove({ cli: engine, models: ["claude-haiku-5-5"], out });
    expect(runs.map((run) => `${run.setting}:${run.task}:${run.found}:${run.toolSearches}:${run.exit}`)).toEqual([
      "off:first-request:null:0:0", "off:text:true:0:0", "off:routine:true:0:0",
      "on:first-request:null:0:0", "on:text:true:1:0", "on:routine:true:1:0",
    ]);
    const first = (setting: string) => runs.find((run) => run.setting === setting && run.task === "first-request")!.firstRequestTokens!;
    expect(first("on")).toBeLessThan(first("off"));
    expect(runs.find((run) => run.setting === "on" && run.task === "text")!.calls).toEqual([{ name: "send_text", arguments: { to: "555-0100", text: "Running ten minutes late." } }]);
    const summary = readFileSync(join(out, "summary.md"), "utf8");
    expect(summary).toContain("| claude-haiku-5-5 | off | on | text |");
    expect(summary).toContain("found send_text");
    expect(JSON.parse(readFileSync(join(out, "results.json"), "utf8")).runs).toHaveLength(6);
  }, 60_000);
});
