import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
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

async function jobThatOutlivesItsTurn(bot: { id: string; threadId: string }, seconds: number, marker: string) {
  writeFileSync(runFile(), JSON.stringify({ command: `sleep ${seconds}; echo ${marker} > ${marker}.txt`, folder: join(home, "site") }));
  const before = ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=80`)).body.messages as any[]).length;
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: `Run the ${marker} build on your computer`, threadId: bot.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(400);
  await until(async () => ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=80`)).body.messages as any[]).slice(before),
    (rows) => rows.some((row) => row.role === "bot" && row.kind === "text"), "the dog's reply");
  writeFileSync(runFile(), "");
  return until(() => botNow(bot.id), (now) => now && !now.busy, "the turn to end");
}

it("a job on the dog's computer that outlives its turn keeps the chat running, then the chat goes idle when the job ends", async () => {
  const created = await api("POST", "/api/bots", { name: "Scout", modelSelection: { instanceId: "own", model: "claude-sonnet-5" } });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(400);
  const bot = created.body.bot as { id: string; threadId: string };

  const after = await jobThatOutlivesItsTurn(bot, 8, "first");
  expect(after.work, log.slice(-3000)).toEqual({ kind: "running", computerJobs: 1 });
  expect(after.helpersWorking).toBe(1);
  expect(after.waitingForTeammates).toBe(false);
  expect(JSON.parse(readFileSync(join(dataDir, "computer-jobs.json"), "utf8"))).toHaveLength(1);

  const ended = await until(() => botNow(bot.id), (now) => now.work?.kind === "idle", "the chat to go idle once the job ended", 30_000);
  expect(existsSync(join(remote, "runs", runKey(join(home, "site")), "first.txt"))).toBe(true);
  expect(ended.helpersWorking).toBeUndefined();
  expect(JSON.parse(readFileSync(join(dataDir, "computer-jobs.json"), "utf8"))).toEqual([]);
}, 120_000);

it("a job still alive across a home restart shows running after the restart, and idle once it really ends", async () => {
  const created = await api("POST", "/api/bots", { name: "Patch", modelSelection: { instanceId: "own", model: "claude-sonnet-5" } });
  const bot = created.body.bot as { id: string; threadId: string };
  const after = await jobThatOutlivesItsTurn(bot, 25, "second");
  expect(after.work).toEqual({ kind: "running", computerJobs: 1 });

  await waitForExit(child, { signal: "SIGTERM" });
  log += "\n--- restart ---\n";
  await startHome();
  const back = await until(() => botNow(bot.id), (now) => Boolean(now), "the dog after the restart");
  expect(back.work, log.slice(-3000)).toEqual({ kind: "running", computerJobs: 1 });
  expect(back.helpersWorking).toBe(1);

  expect(existsSync(join(remote, "runs", runKey(join(home, "site")), "second.txt"))).toBe(false);
  await until(() => botNow(bot.id), (now) => now.work?.kind === "idle", "the chat to go idle once the job ended", 45_000);
  expect(existsSync(join(remote, "runs", runKey(join(home, "site")), "second.txt"))).toBe(true);
}, 150_000);
