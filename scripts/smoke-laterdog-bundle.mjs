import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dogToken } from "../server/laterdog/dog-access.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "dist-server", "laterdog");
const argument = (name) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const skipBuild = process.argv.includes("--skip-build");
const evidence = resolve(argument("--evidence") ?? join(root, ".laterdog-evidence", `supervisor-bundle-${new Date().toISOString().replace(/[:.]/g, "-")}`));
mkdirSync(evidence, { recursive: true });
console.log(`evidence: ${evidence}`);

const adminToken = randomBytes(32).toString("base64url");
const claudeToken = `sk-ant-oat01-${randomBytes(72).toString("base64url")}`;
const computersKey = `ldc_${randomBytes(24).toString("hex")}`;
const botId = "fixture-dog";
const dogCredential = dogToken(adminToken, botId);
const secrets = [adminToken, claudeToken, computersKey, dogCredential];
const redact = (text) => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);

const receipt = { startedAt: new Date().toISOString(), node: process.version, checks: [], limits: [
  "Compiled supervisor bundle only: no provider task, computers service, GitHub, native CLI or container image was exercised.",
  "The computers URL is a loopback listener that counts requests; git, gh and codex are stubs that fail closed.",
] };
const pass = (name, detail) => { receipt.checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) }); console.log(`PASS ${name}`); };
const failure = (name, detail) => { receipt.checks.push({ name, ok: false, detail }); throw new Error(`${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); };
const expect = (name, condition, detail) => (condition ? pass(name) : failure(name, detail ?? "failed"));

const freePort = () => new Promise((done, fail) => {
  const probe = createSocketServer();
  probe.once("error", fail);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); });
});
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const work = mkdtempSync(join(tmpdir(), "laterdog-bundle-smoke-"));
const home = join(work, "home");
const data = join(work, "data");
const stubs = join(work, "bin");
const stubLog = join(work, "stub-calls.log");
const children = [];
let computers;
const computersHits = [];

const pidsFile = join(evidence, "children.json");
const recordChild = (name, child) => {
  children.push(child);
  receipt.children = [...(receipt.children ?? []), { name, pid: child.pid }];
  writeFileSync(pidsFile, `${JSON.stringify(receipt.children)}\n`);
};

function finish(ok, error) {
  receipt.ok = ok;
  receipt.finishedAt = new Date().toISOString();
  if (error) receipt.error = redact(String(error instanceof Error ? error.message : error));
  for (const name of ["stub-calls.log", "server-1.log", "server-2.log", "mcp.log"]) {
    if (existsSync(join(work, name))) writeFileSync(join(evidence, name), redact(readFileSync(join(work, name), "utf8")));
  }
  receipt.computersRequests = computersHits.length;
  writeFileSync(join(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

const exitOf = (child) => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode !== null) return done();
  child.once("exit", () => done());
});

async function stopAll() {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([exitOf(child), wait(12_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exitOf(child);
    }
  }
  await new Promise((done) => (computers ? computers.close(done) : done()));
}

let closing;
function close(ok, error) {
  closing ??= (async () => {
    try { finish(ok, error); } catch (writeError) { console.error(`evidence write failed: ${redact(String(writeError))}`); }
    try { await stopAll(); } finally { rmSync(work, { recursive: true, force: true }); }
  })();
  return closing;
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    close(false, new Error(`interrupted by ${signal}`)).finally(() => { console.error(`FAIL interrupted by ${signal}\nevidence: ${evidence}`); process.exit(code); });
  });
}

function build() {
  if (skipBuild) return pass("build skipped by --skip-build");
  const result = spawnSync("pnpm", ["laterdog:build"], { cwd: root, encoding: "utf8", timeout: 240_000, env: { ...process.env, CI: "1" } });
  writeFileSync(join(evidence, "build.log"), redact(`${result.stdout ?? ""}${result.stderr ?? ""}`));
  expect("pnpm laterdog:build exits 0", result.status === 0, `status ${result.status}`);
  for (const file of ["main.js", "mcp.js", "bridge.js"]) expect(`dist-server/laterdog/${file} exists`, existsSync(join(bundle, file)));
}

function writeFixture(port, computersPort) {
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(stubs, { recursive: true });
  for (const name of ["git", "gh", "codex", "claude"]) {
    const file = join(stubs, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${stubLog}"\necho "${name} is a fixture stub and always fails" >&2\nexit 1\n`);
    chmodSync(file, 0o755);
  }
  writeFileSync(join(data, "config.json"), JSON.stringify({
    profiles: [{ id: "cloud", label: "Fixture cloud", backend: "laterdog-cloud", account: "claude", maxComputerSize: "standard" }],
    concurrency: 2, pollIntervalMs: 0,
  }));
  return { port, computersPort };
}

function childEnvironment(port, computersPort, extra = {}) {
  return {
    PATH: `${stubs}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home, TMPDIR: work, LANG: "C",
    LATERDOG_HOME: join(home, ".laterdog"), LATERDOG_DATA_DIR: data,
    LATERDOG_PORT: String(port), LATERDOG_BIND: "127.0.0.1", LATERDOG_TOKEN: adminToken,
    CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
    LATERDOG_COMPUTERS_URL: `http://127.0.0.1:${computersPort}/v1`, LATERDOG_COMPUTERS_KEY: computersKey,
    ...extra,
  };
}

async function api(port, method, path, body, token = adminToken, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json };
}

async function startServer(logName, port, computersPort) {
  const log = join(work, logName);
  const child = spawn(process.execPath, [join(bundle, "main.js")], { cwd: work, env: childEnvironment(port, computersPort), stdio: ["ignore", "pipe", "pipe"] });
  recordChild(logName, child);
  const lines = [];
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { lines.push(String(chunk)); writeFileSync(log, lines.join("")); });
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  const deadline = Date.now() + 20_000;
  for (;;) {
    const early = await Promise.race([exited, wait(150).then(() => null)]);
    if (early) return failure(`${logName}: compiled main.js stays up`, { exit: early, output: redact(lines.join("")).slice(-1500) });
    try {
      const probe = await api(port, "GET", "/v1/workspace");
      if (probe.status === 200) return child;
    } catch {}
    if (Date.now() > deadline) return failure(`${logName}: authenticated HTTP within 20s`, redact(lines.join("")).slice(-1500));
  }
}

async function stopServer(child) {
  child.kill("SIGTERM");
  await Promise.race([exitOf(child), wait(15_000)]);
  expect("compiled main.js exits on SIGTERM", child.exitCode !== null || child.signalCode !== null);
}

function mcpSession(port) {
  const child = spawn(process.execPath, [join(bundle, "mcp.js")], { cwd: work, stdio: ["pipe", "pipe", "pipe"],
    env: { ...childEnvironment(port, 0), LATERDOG_SUPERVISOR_URL: `http://127.0.0.1:${port}`, LATERDOG_TOKEN: dogCredential,
      LATERDOG_BOT_ID: botId, LATERDOG_CONVERSATION_ID: "fixture-conversation",
      LATERDOG_ACCOUNT: "claude", LATERDOG_MODEL: "claude-opus-5-5", LATERDOG_EFFORT: "high" } });
  recordChild("mcp", child);
  const pending = new Map();
  let buffer = "";
  const transcript = [];
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      transcript.push(line);
      writeFileSync(join(work, "mcp.log"), transcript.join("\n"));
      try { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); } catch {}
    }
  });
  let counter = 0;
  const request = (method, params) => new Promise((done, fail) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`MCP ${method} timed out`)); }, 30_000);
    pending.set(id, (message) => { clearTimeout(timer); done(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return { request, close: () => child.kill("SIGTERM") };
}

const delegation = (requestKey, extra = {}) => ({ name: "delegate_cloud_job", arguments: {
  requestKey, repository: "fixture/first", title: "Fixture change", brief: "Prove the compiled bundle", writeScopes: ["src"], profileId: "cloud", ...extra } });

async function run() {
  build();
  const port = await freePort();
  const computersPort = await freePort();
  computers = createServer((req, res) => { computersHits.push(`${req.method} ${req.url}`); res.writeHead(503).end(); });
  await new Promise((done) => computers.listen(computersPort, "127.0.0.1", done));
  writeFixture(port, computersPort);

  const first = await startServer("server-1.log", port, computersPort);
  const unauthenticated = await api(port, "GET", "/v1/workspace", undefined, "wrong-token");
  expect("a wrong token is refused", unauthenticated.status === 401 || unauthenticated.status === 403, unauthenticated.status);
  const repository = await api(port, "POST", "/v1/repositories", { slug: "fixture/first", environmentId: "none", environments: { "laterdog-cloud": "none" } });
  expect("fixture repository saved", repository.status === 200, repository);

  const mcp = mcpSession(port);
  const listed = await mcp.request("tools/list", {});
  expect("compiled MCP offers delegate_cloud_job to a dog", listed.result?.tools?.some((tool) => tool.name === "delegate_cloud_job"), listed);

  const requestKey = `bundle-${randomUUID()}`;
  const created = await mcp.request("tools/call", delegation(requestKey, { computerSize: "xlarge" }));
  expect("compiled MCP creates the job", created.result && !created.result.isError, created);
  const receiptJob = JSON.parse(created.result.content[0].text);
  const jobId = receiptJob.id;
  const stored = await api(port, "GET", `/v1/jobs/${jobId}`, undefined, dogCredential, { "x-laterdog-bot": botId });
  const storedJob = stored.json.job;
  expect("job record reads back over HTTP", stored.status === 200, stored);
  expect("job inherits model, account and effort from the dog", storedJob.model === "claude-opus-5-5" && storedJob.account === "claude" && storedJob.effort === "high", storedJob);
  expect("requested xlarge clamps to the profile ceiling standard", storedJob.computerSize === "standard", storedJob.computerSize);
  const clamps = (stored.json.events ?? []).filter((event) => event.type === "computer_size_clamped");
  expect("one computer_size_clamped event is stored with the asked and ceiling sizes", clamps.length === 1 && /xlarge/.test(clamps[0].detail) && /standard/.test(clamps[0].detail), clamps);
  expect("job names its dog and backend", storedJob.botId === botId && storedJob.backend === "laterdog-cloud", storedJob);

  const refusal = await api(port, "POST", "/v1/jobs", { requestKey: `bundle-${randomUUID()}`, repository: "fixture/first", title: "Bad size", brief: "x", profileId: "cloud", computerSize: "huge" });
  expect("an unknown computer size is a 400", refusal.status === 400, refusal);

  const retry = await mcp.request("tools/call", delegation(requestKey, { computerSize: "xlarge" }));
  const retried = retry.result && !retry.result.isError ? JSON.parse(retry.result.content[0].text) : retry;
  expect("the same requestKey returns the same job", retried.id === jobId, retried);
  const workspace = await api(port, "GET", "/v1/workspace");
  const fixtureJobs = workspace.json.jobs.filter((job) => job.repository === "fixture/first");
  expect("the retry created no second job", fixtureJobs.length === 1, fixtureJobs.length);

  await wait(3_500);
  const settled = await api(port, "GET", `/v1/jobs/${jobId}`);
  expect("no provider task id was ever assigned", !settled.json.job.taskId && !["running", "collecting", "ready"].includes(settled.json.job.state), { state: settled.json.job.state, taskId: settled.json.job.taskId });
  mcp.close();
  await stopServer(first);

  await startServer("server-2.log", port, computersPort);
  const afterRestart = await api(port, "GET", `/v1/jobs/${jobId}`);
  expect("restart retains model, account, effort and size", afterRestart.json.job.model === "claude-opus-5-5" && afterRestart.json.job.account === "claude"
    && afterRestart.json.job.effort === "high" && afterRestart.json.job.computerSize === "standard", afterRestart.json);
  expect("restart still has no provider task id", !afterRestart.json.job.taskId, afterRestart.json.job.taskId);
  expect("the computers listener received no request", computersHits.length === 0, computersHits);
  receipt.jobState = afterRestart.json.job.state;
  receipt.jobBlocker = afterRestart.json.job.blocker ? redact(String(afterRestart.json.job.blocker)) : undefined;
}

let failed;
try { await run(); } catch (error) { failed = error; } finally { await close(!failed, failed); }
if (failed) { console.error(`FAIL ${redact(String(failed.message ?? failed))}\nevidence: ${evidence}`); process.exit(1); }
console.log(`PASS compiled supervisor bundle smoke\nevidence: ${evidence}`);
