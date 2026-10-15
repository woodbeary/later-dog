import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudPairingSignature } from "../cloud-home.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "laterdog-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
let home = "";
let base = "";
let child: ChildProcess | undefined;
let log = "";
let owner = "";
const sockets: Socket[] = [];

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(owner ? { authorization: `Bearer ${owner}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function ownerPairing(): Promise<string> {
  const body = JSON.stringify({ label: "later.dog app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-laterdog-cloud-timestamp": timestamp, "x-laterdog-cloud-nonce": nonce, "x-laterdog-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { code: granted.code })).body.token;
}

const dump = () => join(home, "claude.json");
const launched = () => JSON.parse(readFileSync(dump(), "utf8")) as { argv: string[]; mcpConfig: { mcpServers: { dog: { args: string[] } } } };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "laterdog-auto-review-"));
  const dataDir = join(home, ".laterdog");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "held-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(dump())}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
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
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  owner = await ownerPairing();
}, 45_000);

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

async function newDog(name: string, approvalMode: "ask" | "auto") {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "held", model: "claude-sonnet-5" }, settings: { approvalMode } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot as { id: string };
}

async function startTurn(bot: { id: string }, text: string) {
  const threadId = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: text })).body.task.threadId as string;
  rmSync(dump(), { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId })).status).toBe(202);
  await expect.poll(() => existsSync(dump()), { timeout: 15_000 }).toBe(true);
  const { argv, mcpConfig } = launched();
  const socket = connect(mcpConfig.mcpServers.dog.args.at(-1)!);
  sockets.push(socket);
  socket.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const answers = new Map<string, any>();
  let buffered = "";
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      const message = JSON.parse(line);
      if (message.t === "answer") answers.set(message.id, message);
    }
  });
  const ask = (tool: string, input: Record<string, unknown>) => {
    const id = randomUUID();
    socket.write(`${JSON.stringify({ t: "ask", id, tool, input })}\n`);
    return id;
  };
  const card = async (requestId: string) =>
    ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[]).find((message) => message.card?.requestId === requestId)?.card;
  const stop = async () => {
    socket.destroy();
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
    await expect.poll(async () => ((await api("GET", "/api/bots")).body.bots as any[]).find((candidate) => candidate.id === bot.id)?.busy, { timeout: 15_000 }).toBe(false);
  };
  return { mode: argv[argv.indexOf("--permission-mode") + 1], threadId, ask, answers, card, stop };
}

it("is on by default: an Off-leash dog's engine runs its own reviewer and what it asks reaches the person", async () => {
  expect((await api("GET", "/api/config")).body.features.autoReview).toBe(true);
  const dog = await newDog("Reviewed", "auto");
  const turn = await startTurn(dog, "Point the docs domain at Pages.");
  expect(turn.mode).toBe("auto");
  const asked = turn.ask("Bash", { command: "wrangler dns create docs CNAME pages.dev" });
  await expect.poll(() => turn.card(asked), { timeout: 15_000 }).toMatchObject({ requestType: "permission", tool: "Bash" });
  expect(turn.answers.has(asked)).toBe(false);
  await turn.stop();
}, 60_000);

it("off: Off-leash dogs act without a card, while sends, sandbox exits and Heel dogs still ask", async () => {
  const saved = await api("PATCH", "/api/config", { features: { autoReview: false } });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.features.autoReview).toBe(false);

  const dog = await newDog("Unreviewed", "auto");
  const turn = await startTurn(dog, "Point the docs domain at Pages.");
  expect(turn.mode).toBe("default");
  const dns = turn.ask("Bash", { command: "wrangler dns create docs CNAME pages.dev" });
  await expect.poll(() => turn.answers.get(dns)?.behavior, { timeout: 15_000 }).toBe("allow");
  expect(await turn.card(dns)).toBeUndefined();
  const send = turn.ask("mcp__composio__GMAIL_SEND_EMAIL", { to: "someone@example.test", body: "hi" });
  await expect.poll(() => turn.card(send), { timeout: 15_000 }).toMatchObject({ heldCode: "approval.held.outbound" });
  const sandbox = turn.ask("Bash", { command: "curl https://example.test", dangerouslyDisableSandbox: true });
  await expect.poll(() => turn.card(sandbox), { timeout: 15_000 }).toMatchObject({ heldCode: "approval.held.sandbox" });
  expect(turn.answers.has(send) || turn.answers.has(sandbox)).toBe(false);
  const messages = (await api("GET", `/api/threads/${turn.threadId}/messages?limit=100`)).body.messages as any[];
  expect(messages.filter((message) => message.tool?.name?.startsWith("approved Bash"))).toEqual([]);
  await turn.stop();

  const heel = await newDog("Careful", "ask");
  const careful = await startTurn(heel, "Point the docs domain at Pages.");
  expect(careful.mode).toBe("default");
  const asked = careful.ask("Bash", { command: "wrangler dns create docs CNAME pages.dev" });
  await expect.poll(() => careful.card(asked), { timeout: 15_000 }).toMatchObject({ requestType: "permission" });
  expect(careful.answers.has(asked)).toBe(false);
  await careful.stop();
}, 90_000);

it("back on: the reviewer returns on the next turn", async () => {
  expect((await api("PATCH", "/api/config", { features: { autoReview: true } })).body.features.autoReview).toBe(true);
  const dog = await newDog("Reviewed again", "auto");
  const turn = await startTurn(dog, "Point the docs domain at Pages.");
  expect(turn.mode).toBe("auto");
  await turn.stop();
}, 60_000);
