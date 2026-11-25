import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { commandLink, EngineProcess, RemoteSession } from "../server/laterdog/engine-remote.ts";

const [cli, scratch] = process.argv.slice(2);
if (!cli || !scratch || !isAbsolute(cli) || !isAbsolute(scratch)) {
  throw new Error("usage: node scripts/verify-codex-engine-relay.mjs /absolute/path/to/codex /absolute/scratch-directory");
}

const root = realpathSync(mkdtempSync(join(scratch, "codex-relay-")));
const workspace = join(root, "workspace");
const codexHome = join(root, "codex");
const sessions = join(codexHome, "sessions");
const relayPath = fileURLToPath(new URL("../server/laterdog/engine-relay.ts", import.meta.url));
const firstMarker = `first-turn-${randomUUID()}`;
const secondMarker = `resumed-turn-${randomUUID()}`;
const executionPath = `${dirname(process.execPath)}:/usr/bin:/bin`;
mkdirSync(workspace);
mkdirSync(sessions, { recursive: true });

const requests = [];
const active = new Set();
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const index = requests.push({ raw, authorization: req.headers.authorization });
  const item = { id: `message_${index}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `Fixture answer ${index}.`, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: `response_${index}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `response_${index}`, status: "completed", output: [item] } },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});

function runtime(computerName) {
  const computer = join(root, computerName);
  const relay = commandLink(process.execPath, [relayPath], {
    PATH: executionPath,
    LATERDOG_ENGINE_TEST_ROOT: computer,
  });
  const remote = new RemoteSession(relay, {
    cli,
    args: ["app-server", "--listen", "stdio://"],
    cwd: workspace,
    env: { PATH: executionPath, HOME: codexHome, CODEX_HOME: codexHome },
    roots: [
      { id: "workspace", path: workspace, writable: false, files: [] },
      { id: "config", path: codexHome, writable: false, files: ["config.toml"] },
      { id: "sessions", path: sessions, writable: true },
    ],
    outputIds: ["sessions"],
    mcp: {}, hooks: [], hookEnv: {},
    socketPath: join(root, `${computerName}.sock`),
    stateFile: join(computer, "engine-state.json"),
    lockFile: join(computer, "engine.lock"),
  });
  const engine = new EngineProcess(remote);
  active.add(engine);
  const closed = once(engine, "close").finally(() => active.delete(engine));
  let stderr = "";
  engine.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  const pending = new Map();
  const turns = new Map();
  const notifications = new Map();
  let sequence = 0;
  createInterface({ input: engine.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    }
    if (message.method === "turn/completed") {
      const { turn } = message.params;
      notifications.set(turn.id, turn);
      turns.get(turn.id)?.(turn);
    }
  });

  const send = (frame) => engine.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  const whileOpen = (promise) => Promise.race([
    promise,
    closed.then(([code]) => { throw new Error(`Codex engine exited ${code}: ${stderr}`); }),
  ]);
  const request = (method, params) => whileOpen(new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  }));
  const turn = async (threadId, text) => {
    const started = await request("turn/start", { threadId, input: [{ type: "text", text }] });
    const id = started.turn.id;
    const outcome = notifications.get(id) ?? await whileOpen(new Promise(resolve => turns.set(id, resolve)));
    assert.equal(outcome.status, "completed", stderr);
    return id;
  };
  return { computer, engine, remote, request, cwd: `${computer}${workspace}`, turn, close: async () => {
    engine.stdin.end();
    assert.equal((await closed)[0], 0, stderr);
  }, initialize: async () => {
    const initialized = await request("initialize", { clientInfo: { name: "laterdog_engine_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized" });
    assert.equal(engine.placement, "computer");
    return initialized.userAgent;
  } };
}

const deadline = setTimeout(() => {
  for (const engine of active) engine.kill();
  console.error("The isolated Codex relay check reached its deadline.");
  server.closeAllConnections();
  process.exitCode = 1;
}, 60_000);
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(join(codexHome, "config.toml"), `model="fixture-model"
model_provider="fixture"
cli_auth_credentials_store="file"
[analytics]
enabled=false
[model_providers.fixture]
name="Fixture"
base_url="${base}"
wire_api="responses"
requires_openai_auth=false
`);

  const first = runtime("computer-a");
  const appServer = await first.initialize();
  const started = await first.request("thread/start", {
    model: "fixture-model", modelProvider: "fixture", cwd: first.cwd, approvalPolicy: "never", sandbox: "read-only",
  });
  const threadId = started.thread.id;
  const initialTurn = await first.turn(threadId, firstMarker);
  const file = readdirSync(sessions, { recursive: true }).find(name => name.endsWith(`${threadId}.jsonl`));
  assert(file, "The native session file did not reach the home before turn completion.");
  const checkpoint = readFileSync(join(sessions, file));
  assert(checkpoint.includes(firstMarker), "The home checkpoint omitted the sent turn.");
  assert.deepEqual(first.remote.conflicts, []);
  await first.close();
  rmSync(first.computer, { recursive: true, force: true, maxRetries: 5 });

  const second = runtime("computer-b");
  assert.equal(await second.initialize(), appServer);
  const resumed = await second.request("thread/resume", { threadId, cwd: second.cwd });
  assert.equal(resumed.thread.id, threadId);
  const resumedTurn = await second.turn(threadId, secondMarker);
  assert.notEqual(resumedTurn, initialTurn);
  assert(readFileSync(join(sessions, file)).includes(secondMarker));
  assert.deepEqual(second.remote.conflicts, []);
  assert.equal(requests.length, 2);
  assert(requests[0].raw.includes(firstMarker));
  assert(requests[1].raw.includes(firstMarker));
  assert(requests[1].raw.includes(secondMarker));
  assert(requests.every(request => request.authorization === undefined));
  assert.equal(existsSync(join(codexHome, "auth.json")), false);
  assert.equal(existsSync(join(second.computer, codexHome, "auth.json")), false);
  await second.close();
  console.log(JSON.stringify({ appServer, remoteTurns: 2, sameNativeThread: true, restoredOnFreshComputer: true,
    checkpointSha256: createHash("sha256").update(checkpoint).digest("hex"), providerQualified: false }));
} finally {
  clearTimeout(deadline);
  for (const engine of active) await engine.stopTree(2000, async () => false);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
