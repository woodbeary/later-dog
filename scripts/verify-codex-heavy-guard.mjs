import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { HeavyCommandGuard, preToolUseDecision } from "../server/laterdog/heavy-commands.ts";

const root = mkdtempSync(join(tmpdir(), "laterdog-codex-heavy-"));
const codexHome = join(root, "codex");
mkdirSync(codexHome);
const marker = join(root, "ran.txt");
const tokenFile = join(root, "hook.token");
writeFileSync(tokenFile, "isolated-hook-fixture", { mode: 0o600 });
writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('ran.txt','ran')\"" } }));
const guard = new HeavyCommandGuard();
let requests = 0;
let hooks = 0;
let denied = 0;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (req.url === "/api/internal/hook") {
    assert.equal(req.headers.authorization, "Bearer isolated-hook-fixture");
    const body = JSON.parse(raw);
    hooks++;
    const decision = preToolUseDecision(guard, { active: true, threadId: "fixture", payload: body.payload });
    if (decision) denied++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(decision ? { ok: true, hookSpecificOutput: decision } : { ok: true }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [] }));
    return;
  }
  requests++;
  const body = JSON.parse(raw);
  if (requests === 2) assert.equal(existsSync(marker), false, "first heavy command ran despite denial");
  if (requests === 3) assert.equal(existsSync(marker), true, JSON.stringify({ hooks, denied, outputs: body.input?.filter(item => item.type === "function_call_output"), stderr }));
  const tools = body.tools.flatMap(tool => tool.type === "namespace" ? tool.tools : [tool]);
  const name = tools.find(tool => ["exec_command", "shell_command", "shell"].includes(tool.name))?.name;
  assert(name, "native shell tool missing");
  const args = name === "exec_command" ? { cmd: "pnpm test", workdir: root, yield_time_ms: 10000 } : name === "shell" ? { command: ["bash", "-c", "pnpm test"], workdir: root } : { command: "pnpm test", workdir: root };
  const item = requests < 3
    ? { id: `fc_${requests}`, type: "function_call", call_id: `call_${requests}`, name, arguments: JSON.stringify(args), status: "completed" }
    : { id: "message_done", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture done.", annotations: [] }] };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: `resp_${requests}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item] } },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
writeFileSync(join(codexHome, "config.toml"), `model="fixture-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="${url}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
const child = spawn(process.env.PROBE_CODEX ?? "codex", ["app-server", "-c", "features.shell_snapshot=false"], {
  cwd: root, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: codexHome, LATERDOG_HOOK_URL: url, LATERDOG_HOOK_TOKEN_FILE: tokenFile }, stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
const pending = new Map();
let sequence = 0;
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
let finish;
const completed = new Promise(resolve => { finish = resolve; });
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  const msg = JSON.parse(line);
  if (pending.has(msg.id)) {
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  }
  if (msg.method === "turn/completed") finish(msg.params.turn);
});
const deadline = setTimeout(() => { console.error("Native hook fixture timed out", stderr); process.exit(1); }, 60000);
try {
  await send("initialize", { clientInfo: { name: "laterdog-guard-fixture", version: "1" }, capabilities: { experimentalApi: true } });
  const thread = await send("thread/start", { model: "fixture-model", modelProvider: "fixture", cwd: root, approvalPolicy: "never", sandbox: "danger-full-access" });
  await send("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Run the synthetic commands." }], approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  const result = await completed;
  assert.equal(result.status, "completed", stderr);
  assert.equal(requests, 3);
  assert.equal(denied, 1);
  assert.equal(hooks, 2);
  assert.equal(existsSync(marker), true);
  console.log(JSON.stringify({ passed: true, fullAccess: true, nativeHooks: hooks, deniedBeforeExecution: denied, fallbackExecuted: true }));
} finally {
  clearTimeout(deadline);
  child.kill("SIGTERM");
  lines.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
