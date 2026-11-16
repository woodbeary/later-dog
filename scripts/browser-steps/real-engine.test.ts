import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FIXTURE_ANSWERS } from "./fixture-site.ts";
import { PAGE_FIRST_PROMPT } from "../../server/laterdog/page-tools.ts";
import { servedTools } from "./computer-tools-server.ts";
import { answered, launchArgs, measure, readStream, serverSpec, systemText, taskPrompt } from "./real-engine.ts";
import { todaysScreenTools } from "./screen-server.ts";

const STAND_IN_ENGINE = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const at = (flag) => argv[argv.indexOf(flag) + 1];
const prompt = at("-p");
const servers = Object.keys(JSON.parse(readFileSync(at("--mcp-config"), "utf8")).mcpServers);
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const usage = { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 };
out({ type: "system", subtype: "init", servers });
out({ type: "assistant", message: { id: "m1", usage, content: [{ type: "tool_use", name: "mcp__" + servers[0] + "__open" }] } });
out({ type: "assistant", message: { id: "m2", usage: { ...usage, cache_read_input_tokens: 2000 }, content: [{ type: "text", text: "done" }] } });
const reply = prompt.includes("/shop") ? "$34.50; free over $60" : prompt.includes("/contact") ? "Reference CF-4821" : "Total $218.40, Shipped";
out({ type: "result", result: reply });
`;

let scratch = "";
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

describe("the real-engine browser-steps runner", () => {
  it("counts requests, tokens and tool calls from the engine's stream", () => {
    const stream = [
      { type: "assistant", message: { id: "a", usage: { input_tokens: 5, cache_creation_input_tokens: 4_000 }, content: [{ type: "tool_use", name: "mcp__computer__screenshot" }] } },
      { type: "assistant", message: { id: "a", usage: { input_tokens: 5 }, content: [{ type: "text" }] } },
      { type: "assistant", message: { id: "b", usage: { input_tokens: 9, cache_read_input_tokens: 5_400 }, content: [{ type: "tool_use", name: "mcp__computer__click" }] } },
      { type: "result", result: "Done." },
    ].map((line) => JSON.stringify(line)).join("\n");
    expect(readStream(`${stream}\nnot json\n`)).toEqual({
      requests: 2, inputTokens: 9_414, lastRequestTokens: 5_409, toolCalls: ["mcp__computer__screenshot", "mcp__computer__click"], reply: "Done.",
    });
  });

  it("counts a task done only when the reply holds every expected value", () => {
    expect(answered("find", `It costs ${FIXTURE_ANSWERS.find.price}; shipping is free over ${FIXTURE_ANSWERS.find.threshold}.`)).toBe(true);
    expect(answered("find", `It costs ${FIXTURE_ANSWERS.find.price}.`)).toBe(false);
    expect(answered("form", `Your reference is ${FIXTURE_ANSWERS.form.reference}.`)).toBe(true);
    expect(answered("table", `Order 1042: ${FIXTURE_ANSWERS.table.total}, ${FIXTURE_ANSWERS.table.status}.`)).toBe(true);
    expect(answered("table", FIXTURE_ANSWERS.table.total)).toBe(false);
  });

  it("gives each path the instructions a dog on it gets, and only that path's tools", () => {
    expect(systemText("structured", "claude-opus-5-5")).toContain("agent_browser tools");
    expect(systemText("screen", "claude-opus-5-5")).toContain("Inspect it with screenshots");
    expect(systemText("screen", "claude-opus-5-5")).not.toContain(PAGE_FIRST_PROMPT);
    expect(systemText("screen-capped", "claude-opus-5-5")).toBe(systemText("screen", "claude-opus-5-5"));
    expect(systemText("page", "claude-opus-5-5")).toContain(PAGE_FIRST_PROMPT);
    const args = launchArgs({ prompt: "p", model: "m", mcpConfig: "/m.json", systemFile: "/s.txt", server: "computer" });
    expect(args.slice(0, 2)).toEqual(["-p", "p"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args.at(-1)).toBe("mcp__computer");
    expect(taskPrompt("table", "http://127.0.0.1:1")).toContain("test.buyer");
  });

  it("serves today's screen tools for the before path and later.dog's own computer tools for the new ones", () => {
    expect(todaysScreenTools().find((tool) => tool.name === "screenshot")?.description).toBe("See the assigned cloud desktop at native pixel resolution.");
    const off = servedTools({} as never).map((tool) => tool.name);
    const on = servedTools({ features: { browser: true } } as never).map((tool) => tool.name);
    expect(off).toContain("run_actions");
    expect(off).toContain("zoom");
    expect(off).not.toContain("page_open");
    expect(on).toContain("page_open");
    for (const left of ["exec", "request_secure_form", "fill_secure_field"]) expect(on).not.toContain(left);
    scratch = mkdtempSync(join(tmpdir(), "laterdog-browser-steps-spec-"));
    const page = serverSpec("page", { engine: "", scratch, chromium: "/usr/bin/chromium", callLog: join(scratch, "calls"), port: 9555 }).spec as { args: string[]; env: Record<string, string> };
    expect(page.args.at(-1)).toMatch(/computer-tools-server\.ts$/);
    expect(page.env).toMatchObject({ LATERDOG_BROWSER_STEPS_PAGE_TOOLS: "1", LATERDOG_PAGE_CDP_PORT: "9555" });
    expect(readFileSync(join(scratch, "bin", "xdg-open"), "utf8")).toContain("--remote-debugging-port=9555");
    const capped = serverSpec("screen-capped", { engine: "", scratch, chromium: "/usr/bin/chromium", callLog: join(scratch, "calls"), port: 9556 }).spec as { env: Record<string, string> };
    expect(capped.env.LATERDOG_BROWSER_STEPS_PAGE_TOOLS).toBeUndefined();
  });

  it("runs every model, path and task once against the fixture site and writes the table", async () => {
    scratch = mkdtempSync(join(tmpdir(), "laterdog-browser-steps-run-"));
    const engine = join(scratch, "engine.mjs");
    writeFileSync(engine, STAND_IN_ENGINE);
    chmodSync(engine, 0o755);
    const out = join(scratch, "out");
    const runs = await measure({ cli: engine, models: ["claude-haiku-5-5"], out, engine: "/missing/agent-browser", chromium: "/missing/chromium" });
    expect(runs.map((run) => `${run.path}:${run.task}:${run.requests}:${run.correct}`)).toEqual([
      "structured:find:2:true", "structured:form:2:true", "structured:table:2:true",
      "screen:find:2:true", "screen:form:2:true", "screen:table:2:true",
      "screen-capped:find:2:true", "screen-capped:form:2:true", "screen-capped:table:2:true",
      "page:find:2:true", "page:form:2:true", "page:table:2:true",
    ]);
    expect(readFileSync(runs[0]!.log, "utf8")).toContain('"servers":["browser"]');
    expect(readFileSync(runs[3]!.log, "utf8")).toContain('"servers":["computer"]');
    expect(readFileSync(join(out, "summary.md"), "utf8")).toContain("| claude-haiku-5-5 | screen | table | 2 | 1 | 6020 | 4010 |");
  }, 60_000);
});
