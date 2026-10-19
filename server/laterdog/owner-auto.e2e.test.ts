import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
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
const secret = randomBytes(32).toString("base64url");
let home = "";
let base = "";
let child: ChildProcess | undefined;
let log = "";
let owner = "";
const sockets: Socket[] = [];
let broker: Server | undefined;
const relayed: unknown[] = [];

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

async function startBroker(): Promise<string> {
  broker = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/connectors/connected") return res.end(JSON.stringify({ services: { gmail: { connected: true } } }));
    if (req.url === "/api/tool_router/session/fixture-session" || req.url === "/api/tool_router/session") {
      return res.end(JSON.stringify({ session_id: "fixture-session", mcp: { type: "http", url: `${origin}/mcp` },
        config: { user_id: "fixture-user", multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true } } }));
    }
    if (req.url === "/mcp") {
      relayed.push(body);
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "relay-ok" }] } }));
    }
    return res.end(JSON.stringify({ items: [{ slug: "gmail", connected_account: { id: "fixture-account", status: "ACTIVE" } }] }));
  });
  await new Promise<void>((resolve) => broker!.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
  return origin;
}

beforeAll(async () => {
  const brokerOrigin = await startBroker();
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
    composio: { apiKey: "ak_isolated_fixture", userId: "fixture-user", sessionId: "fixture-session" },
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
      LATERDOG_COMPOSIO_API: `${brokerOrigin}/api`, LATERDOG_COMPOSIO_TOOLKITS_API: `${brokerOrigin}/api`,
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
  if (broker) await new Promise<void>((resolve) => broker!.close(() => resolve()));
});

async function autoReview(on: boolean) {
  const saved = await api("PATCH", "/api/config", { features: { autoReview: on } });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.features.autoReview).toBe(on);
}

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

it("starts with Auto-review on for a home whose dogs never worked Off-leash", async () => {
  expect((await api("GET", "/api/config")).body.features.autoReview).toBe(true);
  expect(JSON.parse(readFileSync(join(home, ".laterdog", "config.json"), "utf8")).features.autoReview).toBe(true);
});

it("with Auto-review off, an owner dog gets the standing grant its reviewer can see, nothing waits for the person, and its questions still do", async () => {
  await autoReview(false);
  const dog = await newDog("Shipper", "auto");
  const turn = await startTurn(dog, "Commit the fix to main and open the release PR.");
  expect(turn.launch.argv[turn.launch.argv.indexOf("--permission-mode") + 1]).toBe("auto");
  expect(turn.launch.settings.autoMode.allow[0]).toBe("$defaults");
  expect(turn.launch.settings.autoMode.allow[1]).toMatch(/^Owner Standing Authorization \(later\.dog\): Jacob has given this agent a standing authorization/);
  expect(turn.launch.settings.autoMode.environment[0]).toBe("$defaults");
  expect(turn.launch.systemPrompt).toContain("You are one of Jacob's own dogs in Jacob's own later.dog workspace");

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
  await expect.poll(() => turn.card(question), { timeout: 10_000 }).toMatchObject({ requestType: "question" });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(turn.answers.has(question)).toBe(false);
  expect((await turn.card(question)).answered).toBeUndefined();
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

async function mintConnectors(botId: string, threadId: string): Promise<string> {
  const minted = await fetch(`${base}/api/testing/internal-capability`, {
    method: "POST", headers: { "content-type": "application/json", "x-laterdog-test-capability": CAPABILITY_KEY },
    body: JSON.stringify({ botId, threadId, kind: "connectors" }),
  });
  expect(minted.status).toBe(201);
  return (await minted.json() as { token: string }).token;
}

function relay(token: string, name: string, args: unknown) {
  return fetch(`${base}/api/internal/connectors/mcp`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } }),
  }).then(async (response) => ({ status: response.status, body: await response.json() as any }));
}

const sendCards = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[])
  .filter((message) => message.card?.outboundRequest);

it("with Auto-review off an owner dog sends through a connected app with no card, and with it on the send asks", async () => {
  await autoReview(false);
  const mailer = await newDog("Mailer", "auto");
  const before = relayed.length;
  const sent = await relay(await mintConnectors(mailer.id, mailer.threadId), "GMAIL_SEND_EMAIL", { to: "friend@example.test", body: "On my way." });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(sent.body.result?.isError, JSON.stringify(sent.body)).not.toBe(true);
  expect(relayed).toHaveLength(before + 1);
  expect(await sendCards(mailer.threadId)).toHaveLength(0);
  expect((await api("GET", `/api/bots/${mailer.id}/outbound`)).body.today).toBe(1);

  await autoReview(true);
  const careful = await newDog("Careful mailer", "auto");
  const held = relay(await mintConnectors(careful.id, careful.threadId), "GMAIL_SEND_EMAIL", { to: "friend@example.test" });
  await expect.poll(async () => (await sendCards(careful.threadId)).length, { timeout: 10_000 }).toBe(1);
  const [card] = await sendCards(careful.threadId);
  await api("POST", `/api/threads/${careful.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before + 1);
}, 60_000);

it("with Auto-review on, every owner dog runs under the engine's reviewer and what it leaves for the person becomes one card", async () => {
  await autoReview(true);
  const once = await newDog("Careful", "ask");
  const turn = await startTurn(once, "Commit the fix to main.");
  expect(turn.launch.argv[turn.launch.argv.indexOf("--permission-mode") + 1]).toBe("auto");
  expect(turn.launch.settings.autoMode.allow[1]).toMatch(/^Owner Standing Authorization \(later\.dog\)/);
  expect(turn.launch.systemPrompt).toContain("You are one of Jacob's own dogs in Jacob's own later.dog workspace");
  const asked = turn.ask("Bash", { command: "git push origin main" });
  await expect.poll(() => turn.card(asked), { timeout: 15_000 }).toMatchObject({ requestType: "permission" });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(turn.answers.has(asked)).toBe(false);
  expect((await turn.messages()).filter((message) => message.card?.requestType === "permission" && !message.card.answered)).toHaveLength(1);
  await api("POST", `/api/threads/${turn.threadId}/respond`, { requestId: (await turn.card(asked)).requestId, behavior: "allow" });
  await expect.poll(() => turn.answers.get(asked)?.behavior, { timeout: 10_000 }).toBe("allow");
  await turn.stop();
}, 60_000);

it("applies 21 of an owner dog's own routines with no card, each with an Undo", async () => {
  await autoReview(true);
  const dog = await newDog("Planner", "auto");
  const minted = await fetch(`${base}/api/testing/internal-capability`, {
    method: "POST", headers: { "content-type": "application/json", "x-laterdog-test-capability": CAPABILITY_KEY },
    body: JSON.stringify({ botId: dog.id, threadId: dog.threadId }),
  });
  expect(minted.status).toBe(201);
  const { token } = await minted.json() as { token: string };
  for (let index = 0; index < 21; index += 1) {
    const proposed = await fetch(`${base}/api/internal/routine-requests`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ fromBotId: dog.id, fromThreadId: dog.threadId, action: "create", routine: {
        name: `Check ${index + 1}`, instructions: `Look at queue ${index + 1}.`, schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
      } }),
    });
    const body = await proposed.json() as { state?: string; appliedBy?: string };
    expect(proposed.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ state: "applied", appliedBy: "self" });
  }
  const routines = ((await api("GET", "/api/routines")).body.routines as Array<{ botId: string; enabled: boolean }>).filter((routine) => routine.botId === dog.id);
  expect(routines.filter((routine) => routine.enabled)).toHaveLength(21);
  const receipts = (await api("GET", `/api/threads/${dog.threadId}/messages?limit=100`)).body.messages.filter((message: any) => message.card?.routineRequest);
  expect(receipts).toHaveLength(21);
  expect(receipts.every((message: any) => message.card.autoApplied === true && message.card.routineRequest.undo)).toBe(true);
  expect(receipts.some((message: any) => !message.card.answered && !message.card.dismissed)).toBe(false);
}, 60_000);

it("with Auto-review off, a push the coordinator dog passes on to another of the owner's dogs goes through", async () => {
  await autoReview(false);
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
    body: JSON.stringify({ toBotId: worker.id, title: "Ship the fix", message: "Jacob says: commit the fix to main, push it and ship the beta OTA update.", oneWay: true }),
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
