import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudPairingSignature } from "../cloud-home.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";
import { runKey } from "./computer-runs.ts";

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST = "laterdog-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
let home = "", dataDir = "", base = "", log = "", token = "", remote = "", port = 0;
let child: ChildProcess | undefined;
let computers: Server | undefined;
const runFile = () => join(home, "run-on-computer.json");

const machines = new Map<string, { id: string; name: string; state: string }>();
const body = (req: IncomingMessage) => new Promise<Buffer>((resolve) => { const parts: Buffer[] = []; req.on("data", (part: Buffer) => parts.push(part)); req.on("end", () => resolve(Buffer.concat(parts))); });

function computersService(): Promise<string> {
  computers = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    const [, top, id, action] = url.pathname.split("/");
    if (top !== "computers") return send(404, { error: { code: "not_found", message: "no such route" } });
    if (!id && req.method === "GET") return send(200, { computers: [...machines.values()] });
    if (!id && req.method === "POST") {
      const input = JSON.parse((await body(req)).toString("utf8")) as { name: string };
      const made = { id: `cmp_${machines.size + 1}`, name: input.name, state: "running" };
      machines.set(made.id, made);
      return send(200, { computer: made });
    }
    const machine = id ? machines.get(id) : undefined;
    if (!machine) return send(404, { error: { code: "not_found", message: "that cloud computer no longer exists" } });
    if (!action) return send(200, { computer: machine });
    if (action === "wake" || action === "sleep") { await body(req); return send(200, { computer: machine }); }
    if (action === "exec") {
      const input = JSON.parse((await body(req)).toString("utf8")) as { command: string };
      const run = spawn("bash", ["-c", input.command], { cwd: remote, env: { PATH: process.env.PATH, HOME: remote }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      run.stdout.on("data", (part) => { stdout += part; });
      run.stderr.on("data", (part) => { stderr += part; });
      run.on("close", (code) => send(200, { exitCode: code, stdout, stderr }));
      return;
    }
    if (action === "files") {
      const path = join(remote, url.searchParams.get("path") ?? "");
      if (req.method === "PUT") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, await body(req)); return send(200, {}); }
      try { const bytes = readFileSync(path); res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(bytes); }
      catch { return send(404, { error: { code: "not_found", message: "no such file" } }); }
    }
    return send(404, { error: { code: "not_found", message: "no such route" } });
  });
  return new Promise((resolve) => computers!.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(computers!.address() as { port: number }).port}`)));
}

async function api(method: string, path: string, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, what: string, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}\n${log.slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

let computersApi = "";
async function startHome() {
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, LATERDOG_HOME: dataDir, LATERDOG_SERVER_PORT: String(port), LATERDOG_WEBHOOK_PORT: String(port + 1),
      LATERDOG_TRIAL_API: "off",
      LATERDOG_CLOUD_ROLE: "home", LATERDOG_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", LATERDOG_CLOUD_ADMIN_URL: "https://cloud.example.test",
      LATERDOG_CLOUD_BOOTSTRAP_SECRET: secret, LATERDOG_PUBLIC_URL: `https://${HOST}`,
      LATERDOG_COMPUTERS_API: computersApi, LATERDOG_COMPUTERS_KEY_FILE: join(dataDir, "computers-key"),
      LATERDOG_COMPUTER_RUN_WAIT_MS: "1500", LATERDOG_COMPUTER_JOB_CHECK_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  await until(async () => {
    if (child?.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, Boolean, "the home to start");
  const payload = JSON.stringify({ label: "later.dog app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await (await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-laterdog-cloud-timestamp": timestamp, "x-laterdog-cloud-nonce": nonce, "x-laterdog-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, payload)}`,
  }, body: payload })).json() as { code: string };
  token = "";
  token = (await api("POST", "/api/auth/pair", { code: granted.code })).body.token;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "laterdog-work-state-truth-"));
  dataDir = join(home, ".laterdog");
  remote = join(home, "remote");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(remote, { recursive: true });
  mkdirSync(join(home, "site"), { recursive: true });
  writeFileSync(join(home, "site", "page.txt"), "page\n");
  writeFileSync(join(dataDir, "computers-key"), `ldc_${randomBytes(16).toString("hex")}`);
  const cli = join(home, "claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
process.env.FAKE_CLAUDE_RUN_ON_COMPUTER = ${JSON.stringify(runFile())};
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi", "claude"].map((id) => [id, { driver: "not-a-real-driver" }])),
      own: { driver: "claudeAgent", displayName: "Own", config: { cli } },
    },
  }));
  computersApi = await computersService();
  port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  await startHome();
}, 90_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  await new Promise((resolve) => computers ? computers.close(resolve) : resolve(undefined));
  if (home) await removeTempDir(home);
});

const botNow = async (id: string) => ((await api("GET", "/api/bots")).body.bots as any[]).find((bot) => bot.id === id);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const wakeLines = async (threadId: string) => (await messages(threadId)).filter((row) => row.tool?.pickup === "computer");
const remoteFile = (marker: string) => join(remote, "runs", runKey(join(home, "site")), `${marker}.txt`);
const ledger = () => JSON.parse(readFileSync(join(dataDir, "computer-jobs.json"), "utf8")) as Array<{ id: string; end?: unknown }>;
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function jobThatOutlivesItsTurn(bot: { id: string; threadId: string }, seconds: number, marker: string, command = `sleep ${seconds}; echo ${marker} > ${marker}.txt`) {
  writeFileSync(runFile(), JSON.stringify({ command, folder: join(home, "site") }));
  const before = (await messages(bot.threadId)).length;
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: `Run the ${marker} build on your computer`, threadId: bot.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(400);
  await until(async () => (await messages(bot.threadId)).slice(before),
    (rows) => rows.some((row) => row.role === "bot" && row.kind === "text"), "the dog's reply");
  writeFileSync(runFile(), "");
  return until(() => botNow(bot.id), (now) => now && !now.busy, "the turn to end");
}

async function newDog(name: string) {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "own", model: "claude-sonnet-5" } });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(400);
  return created.body.bot as { id: string; threadId: string };
}

async function wokenOnceAndRead(bot: { id: string; threadId: string }, marker: string, name: string) {
  await until(() => wakeLines(bot.threadId), (rows) => rows.length > 0, "the wake line", 45_000);
  await until(() => existsSync(join(home, "site", `${marker}.txt`)), Boolean, "the result brought back by the woken dog", 45_000);
  await until(() => botNow(bot.id), (now) => now.work?.kind === "idle" && !now.busy, "the chat to settle", 45_000);
  await settle(3_000);
  const lines = await wakeLines(bot.threadId);
  expect(lines.map((row) => row.tool.name)).toEqual([`recovery: ${name}'s command finished, so it is carrying on.`]);
  expect(ledger()).toEqual([]);
}

it("a job that outlives its turn keeps the chat running, then wakes the dog once, which reads the result", async () => {
  const bot = await newDog("Scout");
  const after = await jobThatOutlivesItsTurn(bot, 8, "first");
  expect(after.work, log.slice(-3000)).toMatchObject({ kind: "running", computerJobs: 1 });
  expect(after.work.computerSince).toEqual(expect.any(Number));
  expect(after.helpersWorking).toBe(1);
  expect(after.waitingForTeammates).toBe(false);
  expect(ledger()).toHaveLength(1);
  await wokenOnceAndRead(bot, "first", "Scout");
  expect(existsSync(remoteFile("first"))).toBe(true);
}, 150_000);

it("a job alive across a restart shows running after it, and the dog is woken once when it ends", async () => {
  const bot = await newDog("Patch");
  const after = await jobThatOutlivesItsTurn(bot, 25, "second");
  expect(after.work).toMatchObject({ kind: "running", computerJobs: 1 });
  await waitForExit(child, { signal: "SIGTERM" });
  log += "\n--- restart ---\n";
  await startHome();
  const back = await until(() => botNow(bot.id), (now) => Boolean(now), "the dog after the restart");
  expect(back.work, log.slice(-3000)).toMatchObject({ kind: "running", computerJobs: 1 });
  expect(existsSync(remoteFile("second"))).toBe(false);
  await wokenOnceAndRead(bot, "second", "Patch");
}, 180_000);

it("a job that ends while the home is down wakes the dog once after the restart", async () => {
  const bot = await newDog("Biscuit");
  await jobThatOutlivesItsTurn(bot, 6, "third");
  await waitForExit(child, { signal: "SIGTERM" });
  log += "\n--- restart ---\n";
  await until(() => existsSync(remoteFile("third")), Boolean, "the job to end while the home is down", 30_000);
  await settle(1_000);
  await startHome();
  await wokenOnceAndRead(bot, "third", "Biscuit");
}, 180_000);

const alive = (pattern: string) => spawnSync("pgrep", ["-f", pattern]).status === 0;

for (const [shape, seconds, command] of [
  ["a plain command", 3271, "sleep 3271"],
  ["a command followed by more", 3272, "sleep 3272; echo fourth > fourth.txt"],
  ["a command inside another shell", 3273, "bash -c 'sleep 3273; true'"],
] as const) {
  it(`the person's Stop ends ${shape} itself, and nobody is woken`, async () => {
    const bot = await newDog(`Rex${seconds}`);
    const after = await jobThatOutlivesItsTurn(bot, seconds, "fourth", command);
    expect(after.work).toMatchObject({ kind: "running", computerJobs: 1 });
    expect(alive(`sleep ${seconds}`)).toBe(true);
    const stopped = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    await until(() => botNow(bot.id), (state) => state.work?.kind !== "running", "the chat to stop running", 30_000);
    expect(alive(`sleep ${seconds}`)).toBe(false);
    await settle(3_000);
    expect(await wakeLines(bot.threadId)).toEqual([]);
    expect(ledger()).toEqual([]);
  }, 120_000);
}
