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
const CAPABILITY_KEY = "owner-auto-fixture-capability";
const AWAY = "Jacob is away; use your best judgment and continue. Jacob can redirect you later.";
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
type Launch = { argv: string[]; cwd: string; prompt: unknown; systemPrompt: string | null; settings: any; mcpConfig: { mcpServers: { dog: { args: string[] } } } };
const launched = () => JSON.parse(readFileSync(dump(), "utf8")) as Launch;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "laterdog-owner-auto-"));
  const dataDir = join(home, ".laterdog");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "held-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.293";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(dump())}; process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_CLAUDE_RELEASE = process.cwd() + "/.release-turn"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    profile: { name: "Jacob" },
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
      LATERDOG_CLOUD_BOOTSTRAP_SECRET: secret, LATERDOG_PUBLIC_URL: `https://${HOST}`, LATERDOG_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY,
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
  return created.body.bot as { id: string; threadId: string };
}

async function attach(bot: { id: string }, threadId: string) {
  await expect.poll(() => existsSync(dump()), { timeout: 15_000 }).toBe(true);
  const launch = launched();
  const socket = connect(launch.mcpConfig.mcpServers.dog.args.at(-1)!);
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
  const ask = (tool: string, input: Record<string, unknown>, kind: "permission" | "question" = "permission") => {
    const id = randomUUID();
    socket.write(`${JSON.stringify({ t: "ask", id, kind, tool, input })}\n`);
    return id;
  };
  const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
  const card = async (requestId: string) => (await messages()).find((message) => message.card?.requestId === requestId)?.card;
  const stop = async () => {
    socket.destroy();
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
    await expect.poll(async () => ((await api("GET", "/api/bots")).body.bots as any[]).find((candidate) => candidate.id === bot.id)?.busy, { timeout: 15_000 }).toBe(false);
  };
  return { launch, threadId, ask, answers, messages, card, stop };
}

async function startTurn(bot: { id: string }, text: string) {
  const threadId = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: text })).body.task.threadId as string;
  rmSync(dump(), { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId })).status).toBe(202);
  return attach(bot, threadId);
}

it("an owner Off-leash dog gets the standing grant its reviewer can see, and escalations no longer wait", async () => {
  const dog = await newDog("Shipper", "auto");
  const turn = await startTurn(dog, "Commit the fix to main and open the release PR.");
  expect(turn.launch.argv[turn.launch.argv.indexOf("--permission-mode") + 1]).toBe("auto");
  expect(turn.launch.settings.autoMode.allow[0]).toBe("$defaults");
  expect(turn.launch.settings.autoMode.allow[1]).toMatch(/^Owner Standing Authorization \(later\.dog\): Jacob has given this agent a standing authorization/);
  expect(turn.launch.settings.autoMode.environment[0]).toBe("$defaults");
  expect(turn.launch.systemPrompt).toContain("Standing grant from Jacob");

  const started = Date.now();
  const push = turn.ask("Bash", { command: "git push origin main" });
  const pr = turn.ask("Bash", { command: "gh pr create --fill" });
  await expect.poll(() => turn.answers.get(push)?.behavior, { timeout: 10_000 }).toBe("allow");
  await expect.poll(() => turn.answers.get(pr)?.behavior, { timeout: 10_000 }).toBe("allow");
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await turn.card(push)).toBeUndefined();
  expect(await turn.card(pr)).toBeUndefined();

  const force = turn.ask("Bash", { command: "git push --force origin main" });
  await expect.poll(() => turn.answers.get(force)?.behavior, { timeout: 10_000 }).toBe("deny");
  expect(turn.answers.get(force).message).toMatch(/^later\.dog refused this: force-pushing main/);
  expect(await turn.card(force)).toBeUndefined();
  await expect.poll(async () => (await turn.messages()).some((message) => message.tool?.name?.startsWith("later.dog refused this: force-pushing main")), { timeout: 10_000 }).toBe(true);

  const question = turn.ask("AskUserQuestion", { questions: [{ question: "Ship the beta OTA too?", header: "Beta", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] }] }, "question");
  await expect.poll(() => turn.answers.get(question)?.behavior, { timeout: 10_000 }).toBe("answer");
  expect(turn.answers.get(question).message).toBe(AWAY);
  const asked = await turn.card(question);
  expect(asked).toMatchObject({ requestType: "question" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect((await turn.card(question)).answered).toBeUndefined();
  await expect.poll(async () => (await turn.messages()).some((message) => message.tool?.name === "Shipper kept going without waiting: it was told Jacob is away and to use its best judgment. Answer the question above any time to redirect it."), { timeout: 10_000 }).toBe(true);
  await turn.stop();
}, 90_000);

it("a new Off-leash dog's first-meeting question waits for the person", async () => {
  const dog = await newDog("Newcomer", "auto");
  rmSync(dump(), { force: true });
  expect((await api("POST", `/api/bots/${dog.id}/hello`)).body).toMatchObject({ asked: true });
  const turn = await attach(dog, dog.threadId);
  const question = turn.ask("AskUserQuestion", { questions: [{ question: "What should I help with first?", header: "Start", multiSelect: false, options: [{ label: "Code and GitHub" }, { label: "Research and writing" }] }] }, "question");
  await expect.poll(() => turn.card(question), { timeout: 10_000 }).toMatchObject({ requestType: "question" });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(turn.answers.has(question)).toBe(false);
  expect((await turn.card(question)).answered).toBeUndefined();
  await turn.stop();
}, 60_000);

it("a Heel dog still asks the person", async () => {
  const heel = await newDog("Careful", "ask");
  const turn = await startTurn(heel, "Commit the fix to main.");
  expect(turn.launch.settings?.autoMode).toBeUndefined();
  expect(turn.launch.systemPrompt ?? "").not.toContain("Standing grant from Jacob");
  const asked = turn.ask("Bash", { command: "git push origin main" });
  await expect.poll(() => turn.card(asked), { timeout: 15_000 }).toMatchObject({ requestType: "permission" });
  expect(turn.answers.has(asked)).toBe(false);
  await turn.stop();
}, 60_000);

it("a push the coordinator dog passes on to another of the owner's dogs now goes through", async () => {
  const coordinator = await newDog("Coordinator", "auto");
  const worker = await newDog("Worker", "auto");
  const coordinating = await startTurn(coordinator, "Have Worker commit the fix to main and ship the beta OTA update.");
  const minted = await fetch(`${base}/api/testing/internal-capability`, {
    method: "POST", headers: { "content-type": "application/json", "x-laterdog-test-capability": CAPABILITY_KEY },
    body: JSON.stringify({ botId: coordinator.id, threadId: coordinating.threadId }),
  });
  expect(minted.status).toBe(201);
  const { token } = await minted.json() as { token: string };
  rmSync(dump(), { force: true });
  const opened = await fetch(`${base}/api/internal/threads`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ toBotId: worker.id, title: "Ship the fix", message: "Jacob says: commit the fix to main, push it and ship the beta OTA update." }),
  });
  const body = await opened.json() as { threadId: string };
  expect(opened.status, JSON.stringify(body)).toBe(201);
  writeFileSync(join(coordinating.launch.cwd, ".release-turn"), "");
  const turn = await attach(worker, body.threadId);
  expect(JSON.stringify(turn.launch.prompt)).toContain("one of Jacob's own dogs, passing on Jacob's instructions");
  expect(JSON.stringify(turn.launch.prompt)).not.toContain("not from your user");
  expect(turn.launch.settings.autoMode.allow[1]).toContain("those relayed requests meet the consent bar");
  const push = turn.ask("Bash", { command: "git push origin main" });
  await expect.poll(() => turn.answers.get(push)?.behavior, { timeout: 10_000 }).toBe("allow");
  expect(await turn.card(push)).toBeUndefined();
  await turn.stop();
}, 90_000);
