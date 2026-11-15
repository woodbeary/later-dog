import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { claudeCustomEndpoint, deferRareToolsFor } from "../server/laterdog/defer-by-model.ts";
import { dogGuidance } from "../server/laterdog/dog-guidance.ts";
import { agentsServerLaunch } from "../server/laterdog/tool-loading.ts";
import { PROOF_CALLS_FILE, proofTools } from "../server/testing/proof-agents-server.ts";

const PROOF_SERVER = fileURLToPath(new URL("../server/testing/proof-agents-server.ts", import.meta.url));
const RUN_TIMEOUT_MS = 300_000;

export const PROOF_TASKS = [
  { id: "first-request", prompt: "hi", needs: null },
  { id: "text", prompt: "Text Sam at 555-0100 that I'm running ten minutes late.", needs: "send_text" },
  { id: "routine", prompt: "Every Monday at 9am, remind me to water the plants.", needs: "propose_routine" },
] as const;

export type ProofSetting = "off" | "on";

export interface ProofCall { name: string; arguments: Record<string, unknown> }

export interface StreamSummary {
  firstRequestTokens: number | null;
  requests: number;
  toolSearches: number;
  toolUses: string[];
  failedCalls: number;
  reply: string;
}

export interface ProofRun extends StreamSummary {
  model: string;
  setting: ProofSetting;
  task: string;
  needs: string | null;
  found: boolean | null;
  calls: ProofCall[];
  exit: number | null;
  log: string;
}

type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
type Block = { type?: string; name?: string; is_error?: boolean };
type StreamLine = { type?: string; message?: { id?: string; usage?: Usage; content?: Block[] | string }; result?: unknown };

const requestTokens = (usage: Usage | undefined): number | null =>
  usage ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : null;

export function readStream(text: string): StreamSummary {
  const seen = new Set<string>();
  const summary: StreamSummary = { firstRequestTokens: null, requests: 0, toolSearches: 0, toolUses: [], failedCalls: 0, reply: "" };
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: StreamLine;
    try {
      line = JSON.parse(raw) as StreamLine;
    } catch {
      continue;
    }
    const content = Array.isArray(line.message?.content) ? line.message.content : [];
    if (line.type === "assistant") {
      const id = line.message?.id ?? `request-${summary.requests}`;
      if (!seen.has(id)) {
        seen.add(id);
        summary.requests += 1;
        if (summary.requests === 1) summary.firstRequestTokens = requestTokens(line.message?.usage);
      }
      for (const block of content) {
        if (block.type !== "tool_use" || !block.name) continue;
        summary.toolUses.push(block.name);
        if (block.name === "ToolSearch") summary.toolSearches += 1;
      }
    }
    if (line.type === "user") summary.failedCalls += content.filter((block) => block.type === "tool_result" && block.is_error === true).length;
    if (line.type === "result" && typeof line.result === "string") summary.reply = line.result;
  }
  return summary;
}

export function calledWithEverythingRequired(calls: ProofCall[], tool: string): boolean {
  const schema = proofTools({}).find((candidate) => candidate.name === tool)?.inputSchema as { required?: string[] } | undefined;
  const required = schema?.required ?? [];
  return calls.some((call) => call.name === tool && required.every((key) => {
    const value = call.arguments[key];
    return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
  }));
}

export function launchArgs(input: { prompt: string; model: string; mcpConfig: string; systemFile: string }): string[] {
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
    "--allowedTools", "mcp__agents,ToolSearch",
  ];
}

function runCli(cli: string, args: string[], cwd: string, logFile: string): Promise<{ exit: number | null; stdout: string }> {
  return new Promise((done) => {
    const child = spawn(cli, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    const finish = (exit: number | null) => {
      clearTimeout(timer);
      writeFileSync(logFile, `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`);
      done({ exit, stdout });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

export async function proveOne(input: { cli: string; model: string; setting: ProofSetting; task: (typeof PROOF_TASKS)[number]; out: string; withServers?: Record<string, unknown> }): Promise<ProofRun> {
  const name = `${input.model.replace(/[^a-z0-9.-]+/gi, "_")}-${input.setting}-${input.task.id}`;
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-rare-proof-"));
  const callsFile = join(scratch, "calls.jsonl");
  const mcpConfig = join(scratch, "mcp.json");
  const systemFile = join(scratch, "system.txt");
  const work = join(scratch, "work");
  mkdirSync(work);
  writeFileSync(callsFile, "");
  writeFileSync(systemFile, dogGuidance({ engine: "claude", agents: true, model: input.model }));
  const agents = agentsServerLaunch(
    { command: process.execPath, args: ["--experimental-strip-types", PROOF_SERVER], env: { [PROOF_CALLS_FILE]: callsFile } },
    input.setting === "on",
  );
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { ...input.withServers, agents } }, null, 2));
  const log = join(input.out, `${name}.jsonl`);
  const { exit, stdout } = await runCli(input.cli, launchArgs({ prompt: input.task.prompt, model: input.model, mcpConfig, systemFile }), work, log);
  const calls = readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ProofCall);
  return {
    model: input.model,
    setting: input.setting,
    task: input.task.id,
    needs: input.task.needs,
    found: input.task.needs ? exit === 0 && calledWithEverythingRequired(calls, input.task.needs) : null,
    calls,
    exit,
    log,
    ...readStream(stdout),
  };
}

const FOUND_TASKS = ["text", "routine"] as const;

export function modelVerdicts(runs: ProofRun[]): string[] {
  const models = [...new Set(runs.map((run) => run.model))];
  return models.map((model) => {
    const mine = runs.filter((run) => run.model === model);
    const reasons: string[] = [];
    const notExited = mine.filter((run) => run.exit !== 0).length;
    if (notExited) reasons.push(`${notExited} run${notExited === 1 ? "" : "s"} did not exit 0`);
    for (const setting of ["on", "off"] as const) {
      for (const task of FOUND_TASKS) {
        const rows = mine.filter((run) => run.setting === setting && run.task === task);
        const missed = rows.filter((run) => !(run.found === true && run.exit === 0)).length;
        const needs = rows[0]?.needs ?? task;
        if (!rows.length) reasons.push(`${setting}, ${task}: not run`);
        else if (missed) reasons.push(`${setting}, ${task}: ${needs} not found in ${missed} of ${rows.length}${setting === "off" ? ", so the task is not fair" : ""}`);
      }
    }
    const tokens = (setting: ProofSetting) => mine.filter((run) => run.setting === setting && run.task === "first-request").map((run) => run.firstRequestTokens);
    const on = tokens("on");
    const off = tokens("off");
    if (!on.length || !off.length || [...on, ...off].some((value) => value === null)) reasons.push("first request tokens missing");
    else if (Math.max(...(on as number[])) >= Math.min(...(off as number[]))) reasons.push(`first request on (${Math.max(...(on as number[]))}) is not lower than off (${Math.min(...(off as number[]))})`);
    return reasons.length ? `${model}: may not join the table: ${reasons.join("; ")}` : `${model}: may join the table`;
  });
}

export function summaryTable(runs: ProofRun[], customEndpoint: boolean): string {
  const rows = runs.map((run) => {
    const today = deferRareToolsFor({ model: run.model, customEndpoint }, {}) ? "on" : "off";
    const outcome = run.needs ? `${run.found ? "found" : "NOT FOUND"} ${run.needs}` : "-";
    return `| ${run.model} | ${today} | ${run.setting} | ${run.task} | ${run.firstRequestTokens ?? "?"} | ${run.requests} | ${run.toolSearches} | ${run.failedCalls} | ${outcome} | ${run.exit ?? "killed"} |`;
  });
  return [
    `Custom endpoint in this environment: ${customEndpoint ? "yes" : "no"}`,
    "",
    "| model | default today | setting | task | first request tokens | requests | tool searches | failed calls | rare tool | exit |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    ...modelVerdicts(runs),
  ].join("\n");
}

export async function prove(input: { cli: string; models: string[]; out: string; repeat?: number; withServers?: Record<string, unknown> }): Promise<ProofRun[]> {
  mkdirSync(input.out, { recursive: true });
  const runs: ProofRun[] = [];
  for (let round = 0; round < (input.repeat ?? 1); round += 1) {
    for (const model of input.models) {
      for (const setting of ["off", "on"] as const) {
        for (const task of PROOF_TASKS) runs.push(await proveOne({ cli: input.cli, model, setting, task, out: input.out, withServers: input.withServers }));
      }
    }
  }
  const customEndpoint = claudeCustomEndpoint(process.env);
  writeFileSync(join(input.out, "results.json"), JSON.stringify({ customEndpoint, runs }, null, 2));
  writeFileSync(join(input.out, "summary.md"), `${summaryTable(runs, customEndpoint)}\n`);
  return runs;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const models = (option(args, "--models") ?? "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5").split(",").map((model) => model.trim()).filter(Boolean);
  const out = resolve(option(args, "--out") ?? mkdtempSync(join(tmpdir(), "laterdog-rare-proof-out-")));
  const cli = option(args, "--cli") ?? "claude";
  const repeat = Number(option(args, "--repeat") ?? "1");
  const serversFile = option(args, "--with-servers");
  const withServers = serversFile ? (JSON.parse(readFileSync(resolve(serversFile), "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {} : undefined;
  if (withServers && Object.hasOwn(withServers, "agents")) {
    console.error("--with-servers must not name an agents server; the stand-in is the agents server.");
    process.exit(2);
  }
  if (existsSync(join(out, "results.json"))) {
    console.error(`${out} already holds a result; pass a new --out folder.`);
    process.exit(2);
  }
  const runs = await prove({ cli, models, out, repeat: Number.isSafeInteger(repeat) && repeat > 0 ? repeat : 1, withServers });
  console.log(summaryTable(runs, claudeCustomEndpoint(process.env)));
  console.log(`\nRaw turns, results.json and summary.md: ${out}`);
}
