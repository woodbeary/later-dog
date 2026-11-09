import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const after = (flag: string) => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
const sessionId = after("--resume") ?? after("--session-id") ?? "none";
const configDir = process.env.CLAUDE_CONFIG_DIR!;
const sessionFile = join(configDir, "projects", process.env.FAKE_ENGINE_SLUG ?? "slug", `${sessionId}.jsonl`);
if (process.env.FAKE_ENGINE_LAUNCHES) appendFileSync(process.env.FAKE_ENGINE_LAUNCHES, `${process.pid}\n`);
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

function line(command: string, args: string[], input: string, env: NodeJS.ProcessEnv = process.env): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (bytes) => { out += bytes; if (out.includes("\n") && command !== "/bin/sh") child.kill(); });
    child.on("close", (code) => resolve({ out: out.trim(), code }));
    child.stdin.end(input);
  });
}

let turns = 0;
createInterface({ input: process.stdin }).on("line", async (raw) => {
  const text = String(JSON.parse(raw)?.message?.content?.[0]?.text ?? "");
  turns += 1;
  if (text === "hang") { emit({ type: "system", subtype: "hanging" }); return; }
  writeFileSync(join(process.cwd(), `turn-${turns}.txt`), text);
  mkdirSync(join(sessionFile, ".."), { recursive: true });
  appendFileSync(sessionFile, `${JSON.stringify({ text })}\n`);
  if (text === "crash") process.exit(3);
  const reused = existsSync(join(process.cwd(), "node_modules", "marker"));
  mkdirSync(join(process.cwd(), "node_modules"), { recursive: true });
  writeFileSync(join(process.cwd(), "node_modules", "marker"), "installed");
  rmSync(join(process.cwd(), "remove-me.txt"), { force: true });
  const mcpConfig = JSON.parse(readFileSync(after("--mcp-config")!, "utf8")).mcpServers.probe;
  const mcp = await line(mcpConfig.command, mcpConfig.args, `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })}\n`, { ...process.env, ...mcpConfig.env });
  const hookCommand = JSON.parse(readFileSync(after("--settings")!, "utf8")).hooks.PreToolUse[0].hooks[0].command;
  const hook = await line("/bin/sh", ["-c", hookCommand], JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { command: "pnpm install" } }));
  let credential: Record<string, unknown> = {};
  try { credential = JSON.parse(readFileSync(join(configDir, ".credentials.json"), "utf8")).claudeAiOauth; } catch {}
  emit({ type: "result", subtype: "success", result: JSON.stringify({
    input: existsSync("input.txt") ? readFileSync("input.txt", "utf8") : null,
    mcp: mcp.out, hook: hook.out, hookCode: hook.code, reused,
    sessionLines: readFileSync(sessionFile, "utf8").trim().split("\n").length,
    credentialRefresh: "refreshToken" in credential, credentialAccess: typeof credential.accessToken === "string",
    hookAuthorityVisible: Boolean(process.env.LATERDOG_HOOK_TOKEN_FILE || process.env.PROBE_SECRET),
    cwd: process.cwd(),
  }) });
});
process.stdin.on("end", () => process.exit(0));
