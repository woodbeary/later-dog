// Live check of engine placement on a dog's own cloud computer. Runs on a Cloud home (bundled
// with esbuild next to dist-server/laterdog/engine-{relay,proxy}.js) and prints one JSON report.
// It runs the real Claude CLI of the given account on that dog's computer: one session that uses
// Bash, a home MCP tool and a home hook; a second session that resumes it there; and a third that
// resumes it on the home. It touches only its own scratch folder and that account's session file.
//
//   node verify-engine-computer.js <botId> <claudeConfigDir> <scratchDir> [model]
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { engineComputer } from "../server/computers.ts";
import { engineScripts } from "../server/laterdog/engine-computer.ts";
import { computerEngineOpener } from "../server/laterdog/engine-opener.ts";
import { claudeProjectSlug, planClaudeRemote, spawnPlacedEngine } from "../server/laterdog/engine-placement.ts";

const [botId, configDir, scratch, model = "claude-haiku-4-5"] = process.argv.slice(2);
if (!botId || !configDir || !scratch) { console.error("usage: verify-engine-computer <botId> <claudeConfigDir> <scratchDir> [model]"); process.exit(2); }
const cwd = join(scratch, "work");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "from-home.txt"), "written on the home\n");
const sessionId = randomUUID();
const homeLog = join(scratch, "home-side.jsonl");
const mcpServer = join(scratch, "probe-mcp.mjs");
writeFileSync(mcpServer, `import { createInterface } from "node:readline"; import { appendFileSync } from "node:fs";
const say = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l);
  if (m.method === "initialize") say({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } } });
  else if (m.method === "tools/list") say({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "where", description: "Says which machine answers.", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.method === "tools/call") { appendFileSync(${JSON.stringify(homeLog)}, JSON.stringify({ mcp: "where", pid: process.pid }) + "\\n"); say({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "answered by the home, secret " + (process.env.PROBE_SECRET ? "present" : "absent") }] } }); }
  else if (m.id !== undefined) say({ jsonrpc: "2.0", id: m.id, result: {} }); });
`);
const hookScript = join(scratch, "hook.mjs");
writeFileSync(hookScript, `import { appendFileSync } from "node:fs"; let t = ""; process.stdin.on("data", (b) => t += b); process.stdin.on("end", () => { const p = JSON.parse(t); appendFileSync(${JSON.stringify(homeLog)}, JSON.stringify({ hook: p.hook_event_name, tool: p.tool_name, host: process.env.HOSTNAME ?? null }) + "\\n"); });\n`);
const launchDir = join(scratch, "launch");
mkdirSync(launchDir, { recursive: true });
writeFileSync(join(launchDir, "mcp.json"), JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [mcpServer], env: { PROBE_SECRET: "home-only" } } } }));
writeFileSync(join(launchDir, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: `${process.execPath} ${hookScript}`, timeout: 5 }] }] } }));
const cli = execFileSync("sh", ["-lc", "command -v claude"], { encoding: "utf8" }).trim();
const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
for (const key of Object.keys(env)) if (key.startsWith("ANTHROPIC_") || key === "CLAUDE_CODE_OAUTH_TOKEN") delete env[key];
const args = (resume: boolean) => ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", model,
  "--mcp-config", join(launchDir, "mcp.json"), "--strict-mcp-config", "--settings", join(launchDir, "settings.json"), "--setting-sources", "project",
  "--allowedTools", "Bash,Write,mcp__probe__where", "--permission-mode", "acceptEdits", resume ? "--resume" : "--session-id", sessionId];
const message = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
const opener = computerEngineOpener();
const report: Record<string, unknown> = { botId, sessionId, cwd, model, relay: engineScripts().dir, at: new Date().toISOString() };

// "[x]rest" matches the engine's command line but not the shell that runs pgrep.
const pattern = `[${sessionId[0]}]${sessionId.slice(1)}`;
function homeEngines(): number {
  try { return Number(execFileSync("sh", ["-c", `pgrep -f -- '${pattern}' | wc -l`], { encoding: "utf8" }).trim()); } catch { return 0; }
}

async function session(label: string, text: string, resume: boolean, remote: boolean) {
  const started = Date.now();
  const planned = planClaudeRemote({ botId, threadId: `verify-${sessionId}`, sessionId, cliCommand: cli, args: args(resume), cwd, env, managed: false, dataDir: scratch, proxyPath: opener.proxyPath });
  if (!("plan" in planned)) throw new Error(`stays on the home: ${planned.stay}`);
  const placed: string[] = [];
  let localStarts = 0;
  const local = () => { localStarts += 1; return spawn(cli, args(resume), { cwd, env, stdio: ["pipe", "pipe", "pipe"] }); };
  const engine = spawnPlacedEngine(planned.plan, remote ? (plan) => opener.open(botId, plan) : async () => { throw new Error("home run requested"); }, local, (where) => placed.push(where));
  let stderr = "";
  engine.stderr.on("data", (bytes) => { stderr += bytes; });
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: no result; ${stderr.slice(-2000)}`)), 10 * 60_000);
    let duringTurn: Promise<unknown> | null = null;
    createInterface({ input: engine.stdout }).on("line", (line) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame.type === "system" && frame.subtype === "init" && !duringTurn) {
        duringTurn = (async () => {
          const box = remote ? (await engineComputer(botId)).box : null;
          const there = box ? await box.exec(`pgrep -f -- '${pattern}' | wc -l`, 15_000) : null;
          return { homeEngineProcesses: homeEngines(), computerEngineProcesses: there ? Number(there.stdout.trim()) : null };
        })();
      }
      if (frame.type === "result") {
        const filesAtResult = { madeRemotely: existsSync(join(cwd, "made-remotely.txt")), sessionFile: existsSync(join(configDir, "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`)) };
        clearTimeout(timer);
        void (duringTurn ?? Promise.resolve(null)).then((processes) => resolve({ result: frame.result, isError: frame.is_error, filesAtResult, processes }));
      }
    });
    engine.stdin.write(message(text));
  });
  engine.stdin.end();
  const code = await new Promise((resolve) => engine.once("close", resolve));
  return { label, placed, localStarts, exit: code, seconds: Math.round((Date.now() - started) / 100) / 10, ...result, stderr: stderr.slice(-600) };
}

try {
  report.first = await session("computer", "Use Bash to run: echo made-on-the-computer > made-remotely.txt && hostname. Then call the mcp__probe__where tool. Reply with the hostname and the tool's answer, nothing else.", false, true);
  report.second = await session("computer-resume", "What file did you create earlier? Reply with only its name.", true, true);
  report.home = await session("home-resume", "Reply with only the file name you created in this conversation.", true, false);
  report.homeSide = existsSync(homeLog) ? readFileSync(homeLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  report.madeRemotely = existsSync(join(cwd, "made-remotely.txt")) ? readFileSync(join(cwd, "made-remotely.txt"), "utf8").trim() : null;
  report.homeHostname = execFileSync("hostname", { encoding: "utf8" }).trim();
  report.sessionLines = readFileSync(join(configDir, "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`), "utf8").trim().split("\n").length;
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
} catch (error) {
  console.log(JSON.stringify({ ...report, error: (error as Error).message }, null, 2));
  process.exit(1);
}
