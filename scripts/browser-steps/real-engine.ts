import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { BROWSER_PAGE_PROMPT } from "../../server/browser-engine.ts";
import { dogGuidance } from "../../server/laterdog/dog-guidance.ts";
import { computerPrompt } from "../../server/system-prompt.ts";
import { FIXTURE_ACCOUNT, FIXTURE_ANSWERS, startFixtureSite } from "./fixture-site.ts";
import { CALL_LOG } from "./stdio-mcp.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RUN_TIMEOUT_MS = 600_000;

export type Path = "structured" | "screen" | "screen-capped" | "page";
export const PATHS: Path[] = ["structured", "screen", "screen-capped", "page"];
export type TaskName = "find" | "form" | "table";

export function taskPrompt(task: TaskName, origin: string): string {
  if (task === "find") return `On ${origin}/shop, find the price of the Blue Kettle, then follow the Shipping policy link and tell me the order total above which shipping is free. Answer in one line.`;
  if (task === "form") return `Go to ${origin}/contact and send the contact form with name Ada Fixture, email ada@example.test, phone 555-0100, topic Billing and message "My kettle arrived without a lid." This is a local test site and you may submit it. Tell me the reference number it shows.`;
  return `Open ${origin}/orders. It asks you to sign in: use username ${FIXTURE_ACCOUNT.username} and password ${FIXTURE_ACCOUNT.password}, a test account on a local test site. Tell me the total and the status of order ${FIXTURE_ANSWERS.table.order}.`;
}

export function answered(task: TaskName, reply: string): boolean {
  const expected = task === "find" ? [FIXTURE_ANSWERS.find.price, FIXTURE_ANSWERS.find.threshold]
    : task === "form" ? [FIXTURE_ANSWERS.form.reference]
    : [FIXTURE_ANSWERS.table.total, FIXTURE_ANSWERS.table.status];
  return expected.every((value) => reply.includes(value));
}

export function systemText(path: Path, model: string): string {
  return dogGuidance({ engine: "claude", agents: false, model }) + (path === "structured" ? BROWSER_PAGE_PROMPT : computerPrompt("box", { pageTools: path === "page" }));
}

export interface StreamTotals {
  requests: number;
  inputTokens: number;
  lastRequestTokens: number;
  toolCalls: string[];
  reply: string;
}

type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };

export function readStream(text: string): StreamTotals {
  const seen = new Set<string>();
  const totals: StreamTotals = { requests: 0, inputTokens: 0, lastRequestTokens: 0, toolCalls: [], reply: "" };
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: { type?: string; result?: unknown; message?: { id?: string; usage?: Usage; content?: Array<{ type?: string; name?: string }> | string } };
    try { line = JSON.parse(raw); } catch { continue; }
    if (line.type === "assistant") {
      const id = line.message?.id ?? `request-${totals.requests}`;
      if (!seen.has(id)) {
        seen.add(id);
        totals.requests += 1;
        const usage = line.message?.usage ?? {};
        const tokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        totals.inputTokens += tokens;
        totals.lastRequestTokens = tokens;
      }
      const content = Array.isArray(line.message?.content) ? line.message.content : [];
      for (const block of content) if (block.type === "tool_use" && block.name) totals.toolCalls.push(block.name);
    }
    if (line.type === "result" && typeof line.result === "string") totals.reply = line.result;
  }
  return totals;
}

export interface CallRecord { name: string; seconds: number; textBytes: number; imageBytes: number; imageTokens: number; isError: boolean }

export interface EngineRun extends StreamTotals {
  model: string;
  path: Path;
  task: TaskName;
  calls: CallRecord[];
  imageTokens: number;
  toolSeconds: number;
  wallSeconds: number;
  exit: number | null;
  correct: boolean;
  log: string;
}

export function launchArgs(input: { prompt: string; model: string; mcpConfig: string; systemFile: string; server: string }): string[] {
  return [
    "-p", input.prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--model", input.model,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--append-system-prompt-file", input.systemFile,
    "--permission-mode", "default",
    "--mcp-config", input.mcpConfig,
    "--allowedTools", `mcp__${input.server}`,
  ];
}

function runEngine(cli: string, args: string[], cwd: string, log: string): Promise<{ exit: number | null; stdout: string; seconds: number }> {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn(cli, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    const finish = (exit: number | null) => {
      clearTimeout(timer);
      writeFileSync(log, `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`);
      done({ exit, stdout, seconds: (performance.now() - started) / 1000 });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

export function serverSpec(path: Path, env: { engine: string; scratch: string; chromium: string; callLog: string; port: number }): { name: string; spec: Record<string, unknown> } {
  const shared = { [CALL_LOG]: env.callLog, PATH: process.env.PATH ?? "" };
  if (path === "structured") {
    return { name: "browser", spec: { command: process.execPath, args: ["--experimental-strip-types", join(HERE, "structured-server.ts")], env: {
      ...shared, LATERDOG_BROWSER_STEPS_ENGINE: env.engine, LATERDOG_BROWSER_STEPS_HOME: join(env.scratch, "home"), AGENT_BROWSER_EXECUTABLE_PATH: env.chromium,
    } } };
  }
  if (path === "screen") {
    return { name: "computer", spec: { command: process.execPath, args: ["--experimental-strip-types", join(HERE, "screen-server.ts")], env: {
      ...shared, DISPLAY: process.env.DISPLAY ?? ":0", LATERDOG_BROWSER_STEPS_CHROMIUM: env.chromium, LATERDOG_BROWSER_STEPS_PROFILE: join(env.scratch, "profile"),
    } } };
  }
  const bin = join(env.scratch, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\nexec ${JSON.stringify(env.chromium)} --user-data-dir=${JSON.stringify(join(env.scratch, "profile"))} --remote-debugging-port=${env.port} --no-first-run --no-default-browser-check --password-store=basic --window-position=0,0 --window-size=1280,800 "$@"\n`);
  chmodSync(join(bin, "xdg-open"), 0o755);
  return { name: "computer", spec: { command: process.execPath, args: ["--experimental-strip-types", join(HERE, "computer-tools-server.ts")], env: {
    ...shared, PATH: `${bin}:${process.env.PATH ?? ""}`, DISPLAY: process.env.DISPLAY ?? ":0", LATERDOG_PAGE_CDP_PORT: String(env.port),
    ...(path === "page" ? { LATERDOG_BROWSER_STEPS_PAGE_TOOLS: "1" } : {}),
  } } };
}

export async function runOne(input: { cli: string; model: string; path: Path; task: TaskName; origin: string; out: string; engine: string; chromium: string }): Promise<EngineRun> {
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-browser-steps-"));
  try {
    mkdirSync(join(scratch, "home"));
    mkdirSync(join(scratch, "work"));
    const callLog = join(scratch, "calls.jsonl");
    writeFileSync(callLog, "");
    const systemFile = join(scratch, "system.txt");
    writeFileSync(systemFile, systemText(input.path, input.model));
    const server = serverSpec(input.path, { engine: input.engine, scratch, chromium: input.chromium, callLog, port: 9400 + Math.floor(Math.random() * 500) });
    const mcpConfig = join(scratch, "mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [server.name]: server.spec } }, null, 2));
    const log = join(input.out, `${input.model.replace(/[^a-z0-9.-]+/gi, "_")}-${input.path}-${input.task}.jsonl`);
    const args = launchArgs({ prompt: taskPrompt(input.task, input.origin), model: input.model, mcpConfig, systemFile, server: server.name });
    const ran = await runEngine(input.cli, args, join(scratch, "work"), log);
    const calls = readFileSync(callLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as CallRecord);
    const totals = readStream(ran.stdout);
    return {
      model: input.model, path: input.path, task: input.task, ...totals, calls, log,
      imageTokens: calls.reduce((sum, call) => sum + (call.imageTokens ?? 0), 0),
      toolSeconds: calls.reduce((sum, call) => sum + call.seconds, 0),
      wallSeconds: ran.seconds,
      exit: ran.exit,
      correct: ran.exit === 0 && answered(input.task, totals.reply),
    };
  } finally {
    spawnSync("pkill", ["-f", join(scratch, "profile")]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : "0%");

export function summaryTable(runs: EngineRun[]): string {
  return [
    "| model | path | task | model turns | tool calls | input tokens, all requests | last request | image tokens | image share of the last request | tool seconds | wall seconds | done right | exit |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |",
    ...runs.map((run) => `| ${run.model} | ${run.path} | ${run.task} | ${run.requests} | ${run.toolCalls.length} | ${run.inputTokens} | ${run.lastRequestTokens} | ${run.imageTokens} | ${pct(run.imageTokens, run.lastRequestTokens)} | ${run.toolSeconds.toFixed(1)} | ${run.wallSeconds.toFixed(1)} | ${run.correct ? "yes" : "no"} | ${run.exit ?? "killed"} |`),
  ].join("\n");
}

export async function measure(input: { cli: string; models: string[]; out: string; engine: string; chromium: string; paths?: Path[]; tasks?: TaskName[] }): Promise<EngineRun[]> {
  mkdirSync(input.out, { recursive: true });
  const site = await startFixtureSite();
  const runs: EngineRun[] = [];
  try {
    for (const model of input.models) {
      for (const path of input.paths ?? PATHS) {
        for (const task of input.tasks ?? ["find", "form", "table"]) {
          runs.push(await runOne({ cli: input.cli, model, path, task, origin: site.origin, out: input.out, engine: input.engine, chromium: input.chromium }));
        }
      }
    }
  } finally {
    await site.close();
  }
  writeFileSync(join(input.out, "results.json"), `${JSON.stringify({ runs }, null, 2)}\n`);
  writeFileSync(join(input.out, "summary.md"), `${summaryTable(runs)}\n`);
  return runs;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    models: { type: "string", default: "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5" },
    out: { type: "string" },
    cli: { type: "string", default: "claude" },
    engine: { type: "string" },
    chromium: { type: "string", default: "/usr/bin/chromium" },
    paths: { type: "string", default: PATHS.join(",") },
  } });
  const paths = values.paths.split(",").map((path) => path.trim()).filter((path): path is Path => (PATHS as string[]).includes(path));
  if (paths.includes("structured") && !values.engine) throw new Error("--engine <path to the pinned agent-browser binary> is required for the structured path; or pass --paths screen,screen-capped,page");
  if (!process.env.DISPLAY) throw new Error("DISPLAY is required for the screen path: run this under xvfb-run");
  const out = resolve(values.out ?? join(tmpdir(), `browser-steps-real-${Date.now()}`));
  if (existsSync(join(out, "results.json"))) throw new Error(`${out} already holds a result; pass a new --out folder`);
  const runs = await measure({ cli: values.cli, models: values.models.split(",").map((model) => model.trim()).filter(Boolean), out, engine: values.engine ? resolve(values.engine) : "", chromium: values.chromium, paths });
  console.log(summaryTable(runs));
  console.log(`\nRaw turns, results.json and summary.md: ${out}`);
}
