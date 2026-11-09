import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudPairingSignature } from "../cloud-home.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "laterdog-t-0123456789ab.fly.dev";
const NOTICE = "Someone else wrote in this conversation";
const secret = randomBytes(32).toString("base64url");
let home = "", dataDir = "", base = "", log = "";
let child: ChildProcess | undefined;
const proxies: ChildProcess[] = [];
const held = () => join(home, "held.json");

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
async function adminPairing(): Promise<string> {
  const body = JSON.stringify({ label: "later.dog app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-laterdog-cloud-timestamp": timestamp, "x-laterdog-cloud-nonce": nonce, "x-laterdog-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { body: { code: granted.code } })).body.token;
}
async function until(check: () => boolean | Promise<boolean>, what: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${log.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function agentTools() {
  const agents = JSON.parse(readFileSync(held(), "utf8")).mcpConfig.mcpServers.agents;
  const proxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: home, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", (line) => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg.result ?? msg); replies.delete(msg.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next; replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return (name: string, args: unknown) => request("tools/call", { name, arguments: args });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "laterdog-routine-provenance-"));
  dataDir = join(home, ".laterdog");
  mkdirSync(join(home, "projects", "site"), { recursive: true });
  const cli = join(home, "held-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(held())}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    features: { autoReview: true },
    instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi", "claude"].map((id) => [id, { driver: "not-a-real-driver" }])),
      held: { driver: "claudeAgent", displayName: "Held", config: { cli } },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, LATERDOG_HOME: dataDir, LATERDOG_SERVER_PORT: String(port), LATERDOG_WEBHOOK_PORT: String(port + 1),
      LATERDOG_CLOUD_ROLE: "home", LATERDOG_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", LATERDOG_CLOUD_ADMIN_URL: "https://cloud.example.test",
      LATERDOG_CLOUD_BOOTSTRAP_SECRET: secret, LATERDOG_PUBLIC_URL: `https://${HOST}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  await until(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, "the server to start", 25_000);
}, 60_000);

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("a report of the owner's own routine run keeps the owner's Mac open after the routine is edited or deleted from the owner's chat", async () => {
  const owner = await adminPairing();
  const bot = (await api("POST", "/api/bots", { token: owner, body: { name: "Site bot", modelSelection: { instanceId: "held", model: "claude-sonnet-5" } } })).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { token: owner, body: { cwd: join(home, "projects", "site"), approvalMode: "auto" } })).status).toBe(200);
  const schedule = { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 };
  const routineId = (await api("POST", "/api/routines", { token: owner, body: { name: "Nightly", prompt: "Build the site.", botId: bot.id, enabled: false, schedule } })).body.routine.id;
  const reports = async () => ((await api("GET", `/api/threads/${bot.threadId}/messages`, { token: owner })).body.messages as any[]).filter((message) => message.kind === "routine.run");
  const started = () => { try { readFileSync(held(), "utf8"); return true; } catch { return false; } };

  rmSync(held(), { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "Run the nightly, tweak it, then drop it.", threadId: bot.threadId } })).status).toBe(202);
  await until(started, "the owner's turn to start");
  const tools = await agentTools();
  const mac = async () => JSON.stringify(await tools("shared_computer", { action: "list_files", path: "." }));
  expect(await mac()).not.toContain(NOTICE);
  expect(JSON.stringify(await tools("propose_routine_action", { routine_id: routineId, action: "run_now" }))).not.toContain("isError\":true");
  await until(async () => (await reports()).length > 0, "the report of the run");
  const runId = (await reports())[0].routineRun.runId as string;
  expect((await reports())[0].ownersRoutine).toBe(true);
  await api("POST", `/api/routine-runs/${runId}/cancel`, { token: owner });
  expect(await mac()).not.toContain(NOTICE);
  expect(JSON.stringify(await tools("propose_routine_action", { routine_id: routineId, action: "update", changes: { instructions: "Build and test the site." } }))).not.toContain("isError\":true");
  expect(await mac()).not.toContain(NOTICE);
  expect(JSON.stringify(await tools("propose_routine_action", { routine_id: routineId, action: "delete" }))).not.toContain("isError\":true");
  expect((await api("GET", "/api/routines", { token: owner })).body.routines.some((routine: any) => routine.id === routineId)).toBe(false);
  expect((await reports())[0]?.ownersRoutine).toBe(true);
  expect(await mac()).not.toContain(NOTICE);
}, 120_000);
