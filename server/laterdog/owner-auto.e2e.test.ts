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

it("starts with Auto-review off for a home whose dogs never worked Off-leash", async () => {
  expect((await api("GET", "/api/config")).body.features.autoReview).toBe(false);
  expect(JSON.parse(readFileSync(join(home, ".laterdog", "config.json"), "utf8")).features.autoReview).toBe(false);
});

it("with Auto-review off, an owner dog's Claude Code starts without its own reviewer, nothing waits for the person, and its questions still do", async () => {
  await autoReview(false);
  const dog = await newDog("Shipper", "auto");
  const turn = await startTurn(dog, "Commit the fix to main and open the release PR.");
  expect(turn.launch.argv[turn.launch.argv.indexOf("--permission-mode") + 1]).toBe("default");
  expect(turn.launch.argv[turn.launch.argv.indexOf("--permission-prompt-tool") + 1]).toBe("mcp__dog__approve");
  expect(turn.launch.settings?.autoMode).toBeUndefined();
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

it("a delete outside the workspace asks every time, even after the old Always allow was stored", async () => {
  await autoReview(false);
  const dog = await newDog("Cleaner", "auto");
  const turn = await startTurn(dog, "Free disk space.");
  const first = turn.ask("Bash", { command: "rm -rf /srv/old-video-work" });
  await expect.poll(() => turn.card(first), { timeout: 10_000 }).toMatchObject({ requestType: "permission" });
  expect((await turn.card(first)).subtitle).toMatch(/^This deletes \/srv\/old-video-work and everything in it/);
  expect((await turn.card(first)).allowKey).toBeUndefined();
  const offered = await api("POST", `/api/bots/${dog.id}/always-allow`, { threadId: turn.threadId, allowKey: "Delete folders outside its workspace" });
  expect(offered.status).toBe(409);
  expect(turn.answers.has(first)).toBe(false);

  const stored = await api("PATCH", `/api/bots/${dog.id}`, { alwaysAllow: ["Delete folders outside its workspace"] });
  expect(stored.status, JSON.stringify(stored.body)).toBe(200);
  await api("POST", `/api/threads/${turn.threadId}/respond`, { requestId: (await turn.card(first)).requestId, behavior: "allow" });
  await expect.poll(() => turn.answers.get(first)?.behavior, { timeout: 10_000 }).toBe("allow");

  const second = turn.ask("Bash", { command: "rm -rf /srv/other-old-folder" });
  await expect.poll(() => turn.card(second), { timeout: 10_000 }).toMatchObject({ requestType: "permission" });
  expect(turn.answers.has(second)).toBe(false);

  const force = turn.ask("Bash", { command: "git push --force origin main" });
  await expect.poll(() => turn.answers.get(force)?.behavior, { timeout: 10_000 }).toBe("deny");
  await turn.stop();
}, 90_000);

it("a push that skips its checks always asks an owner dog's person, on a card that offers no lasting yes, and the engine's hook asks too", async () => {
  await autoReview(false);
  const dog = await newDog("Hasty", "auto");
  const turn = await startTurn(dog, "Push the fix.");
  const skipped = turn.ask("Bash", { command: "git push --no-verify origin fix/login" });
  await expect.poll(() => turn.card(skipped), { timeout: 10_000 }).toMatchObject({ requestType: "permission" });
  const card = await turn.card(skipped);
  expect(card.subtitle).toMatch(/^This pushes code without running its checks\. A dog always asks you before this, whatever its approval setting\./);
  expect(card.allowKey).toBeUndefined();
  expect(card.allowSession).toBeUndefined();
  expect(card.commandAllowlist).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(turn.answers.has(skipped)).toBe(false);

  const plain = turn.ask("Bash", { command: "git push origin fix/login" });
  await expect.poll(() => turn.answers.get(plain)?.behavior, { timeout: 10_000 }).toBe("allow");

  const entries = turn.launch.settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
  expect(entries.map((entry) => entry.matcher)).toEqual(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
  const tokenFile = entries[0]!.hooks[0]!.command.match(/'([^']+)'$/)![1]!;
  const hook = (payload: Record<string, unknown>) => fetch(`${base}/api/internal/hook`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` },
    body: JSON.stringify({ event: "PreToolUse", payload }),
  }).then((response) => response.json() as Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>);
  expect((await hook({ tool_name: "Bash", tool_input: { command: "LATERDOG_SKIP_HOOKS=1 git push" } })).hookSpecificOutput?.permissionDecision).toBe("ask");
  expect((await hook({ tool_name: "Write", tool_input: { file_path: "scripts/git-hooks/pre-push", content: "exit 0" } })).hookSpecificOutput?.permissionDecision).toBe("ask");
  expect((await hook({ tool_name: "Bash", tool_input: { command: "git push origin fix/login" } })).hookSpecificOutput).toBeUndefined();
  const elsewhere = { tool_name: "Bash", tool_input: { command: "find . -name '*.pdf' -delete" }, cwd: "/srv/person/Documents" };
  expect((await hook(elsewhere)).hookSpecificOutput?.permissionDecision).toBe("ask");
  expect((await hook({ ...elsewhere, cwd: turn.launch.cwd })).hookSpecificOutput).toBeUndefined();
  await turn.stop();
}, 90_000);

async function mint(botId: string, threadId: string, kind: "agents" | "computer" | "browser"): Promise<string> {
  const minted = await fetch(`${base}/api/testing/internal-capability`, {
    method: "POST", headers: { "content-type": "application/json", "x-laterdog-test-capability": CAPABILITY_KEY },
    body: JSON.stringify({ botId, threadId, kind }),
  });
  expect(minted.status).toBe(201);
  return (await minted.json() as { token: string }).token;
}

it("the cloud computer, the browser, run_on_computer and the lent Mac stop at what always asks, with Auto-review off or on", async () => {
  const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const paths: Array<[kind: "agents" | "computer" | "browser", path: string, body: unknown, shown: string]> = [
    ["computer", "/api/internal/computer/mcp", call("exec", { command: "git push --no-verify origin fix" }), "git push --no-verify origin fix"],
    ["browser", "/api/internal/browser/mcp", call("agent_browser_navigate", { url: "https://console.cloud.google.com/apis/credentials" }), "console.cloud.google.com"],
    ["agents", "/api/internal/computer-run", { command: "aws iam create-access-key --user-name bot" }, "aws iam create-access-key"],
    ["agents", "/api/internal/shared-computers", { action: "run_command", command: "rm -rf ~/Documents/old" }, "rm -rf ~/Documents/old"],
  ];
  for (const review of [false, true]) {
    await autoReview(review);
    const dog = await newDog(`Hands ${review}`, "auto");
    for (const [kind, path, body, shown] of paths) {
      const token = await mint(dog.id, dog.threadId, kind);
      const pending = fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
        .then(async (response) => ({ status: response.status, text: await response.text() }));
      const card = async () => ((await api("GET", `/api/threads/${dog.threadId}/messages?limit=100`)).body.messages as any[])
        .find((message) => message.card?.title === "Approval needed" && message.card.subtitle.includes(shown) && !message.card.answered)?.card;
      await expect.poll(card, { timeout: 10_000 }).toMatchObject({ requestType: "permission", options: ["Allow", "Deny"] });
      const shownCard = await card();
      expect(shownCard.subtitle, path).toMatch(/A dog always asks you before this, whatever its approval setting\./);
      expect(shownCard.allowKey, path).toBeUndefined();
      await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: shownCard.requestId, behavior: "deny" });
      const answered = await pending;
      expect(answered.text, path).toContain("The person said no");
    }
    const token = await mint(dog.id, dog.threadId, "computer");
    const allowed = fetch(`${base}/api/internal/computer/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(call("exec", { command: "git push --no-verify origin again" })) })
      .then(async (response) => ({ status: response.status, text: await response.text() }));
    const again = async () => ((await api("GET", `/api/threads/${dog.threadId}/messages?limit=100`)).body.messages as any[])
      .find((message) => message.card?.subtitle?.includes("origin again") && !message.card.answered)?.card;
    await expect.poll(again, { timeout: 10_000 }).toBeTruthy();
    await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: (await again()).requestId, behavior: "allow" });
    expect((await allowed).text).toContain("this turn has no cloud computer");
  }
}, 90_000);

it("an Allow that comes after the dog's call gave up runs nothing, and the card says it was too late", async () => {
  await autoReview(false);
  const dog = await newDog("Impatient", "auto");
  const token = await mint(dog.id, dog.threadId, "agents");
  const caller = new AbortController();
  const pending = fetch(`${base}/api/internal/computer-run`, {
    method: "POST", signal: caller.signal, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ command: "aws iam create-access-key --user-name late" }),
  }).catch(() => "gave up");
  const card = async () => ((await api("GET", `/api/threads/${dog.threadId}/messages?limit=100`)).body.messages as any[])
    .find((message) => message.card?.subtitle?.includes("--user-name late"))?.card;
  await expect.poll(card, { timeout: 10_000 }).toMatchObject({ requestType: "permission" });
  caller.abort();
  expect(await pending).toBe("gave up");
  await expect.poll(async () => (await card())?.answered, { timeout: 10_000 }).toBe("unavailable");
  expect((await card()).subtitle).toContain("Too late: the dog stopped waiting for this answer, so nothing ran. It will ask again if it still needs to.");
  const requestId = (await card()).requestId as string;
  const late = await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId, behavior: "allow" });
  expect(late.body.outcome).toBe("unavailable");
  const rows = (await api("GET", "/api/decisions?limit=500")).body.decisions as Array<{ requestId?: string; decision: string }>;
  expect(rows.filter((row) => row.requestId === requestId).map((row) => row.decision)).toEqual(["card-shown"]);
}, 60_000);

it("a command cannot be saved, and what always asks still asks, off the owner's automatic path", async () => {
  await autoReview(true);
  const dog = await newDog("Saver", "auto");
  const turn = await startTurn(dog, "Push it.");
  for (const command of ["pnpm test", "git push --no-verify origin fix"]) {
    const saved = await api("POST", `/api/bots/${dog.id}/command-allowlist?threadId=${turn.threadId}`, { command, cwd: turn.launch.cwd, providerInstanceId: "held" });
    expect(saved.status, JSON.stringify(saved.body)).toBe(409);
  }
  const ordinary = turn.ask("Bash", { command: "pnpm test" });
  await expect.poll(() => turn.card(ordinary), { timeout: 10_000 }).toMatchObject({ requestType: "permission" });
  expect((await turn.card(ordinary)).commandAllowlist).toBeUndefined();
  expect(turn.answers.has(ordinary)).toBe(false);
  const skipped = turn.ask("Bash", { command: "git push --no-verify origin fix" });
  await expect.poll(() => turn.card(skipped), { timeout: 10_000 }).toMatchObject({ requestType: "permission" });
  expect((await turn.card(skipped)).subtitle).toMatch(/^This pushes code without running its checks\./);
  expect((await turn.card(skipped)).commandAllowlist).toBeUndefined();
  expect(turn.answers.has(skipped)).toBe(false);
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

it("an owner dog's send through a connected app always asks, with Auto-review off or on", async () => {
  await autoReview(false);
  const mailer = await newDog("Mailer", "auto");
  const kept = await api("PATCH", `/api/bots/${mailer.id}`, { alwaysAllow: ["connector:gmail"] });
  expect(kept.status, JSON.stringify(kept.body)).toBe(200);
  const before = relayed.length;
  const asked = relay(await mintConnectors(mailer.id, mailer.threadId), "GMAIL_SEND_EMAIL", { to: "friend@example.test", body: "On my way." });
  await expect.poll(async () => (await sendCards(mailer.threadId)).length, { timeout: 10_000 }).toBe(1);
  const [first] = await sendCards(mailer.threadId);
  expect(first.card.allowKey).toBeUndefined();
  const offered = await api("POST", `/api/bots/${mailer.id}/always-allow`, { threadId: mailer.threadId, allowKey: "connector:gmail" });
  expect(offered.status).toBe(409);
  await api("POST", `/api/threads/${mailer.threadId}/respond`, { requestId: first.card.requestId, behavior: "deny" });
  expect((await asked).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);

  await autoReview(true);
  const careful = await newDog("Careful mailer", "auto");
  const held = relay(await mintConnectors(careful.id, careful.threadId), "GMAIL_SEND_EMAIL", { to: "friend@example.test" });
  await expect.poll(async () => (await sendCards(careful.threadId)).length, { timeout: 10_000 }).toBe(1);
  const [card] = await sendCards(careful.threadId);
  await api("POST", `/api/threads/${careful.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
}, 60_000);

it("lists an app's Always granted on a second chat only, and Remove takes it out of that chat", async () => {
  await autoReview(true);
  const dog = await newDog("Second chat", "ask");
  const second = (await api("POST", `/api/bots/${dog.id}/tasks`, { title: "Second" })).body.task.threadId as string;
  const asked = relay(await mintConnectors(dog.id, second), "GITHUB_CREATE_AN_ISSUE_COMMENT", { owner: "o", repo: "r", issue_number: 1, body: "Thanks." });
  await expect.poll(async () => (await sendCards(second)).length, { timeout: 10_000 }).toBe(1);
  const [card] = await sendCards(second);
  expect(card.card.allowKey).toBe("connector:github");
  expect((await api("POST", `/api/bots/${dog.id}/always-allow`, { threadId: second, allowKey: "connector:github" })).status).toBe(200);
  await api("POST", `/api/threads/${second}/respond`, { requestId: card.card.requestId, behavior: "allow" });
  await asked;
  const record = async () => ((await api("GET", "/api/bots")).body.bots as any[]).find((bot) => bot.id === dog.id);
  expect((await record()).alwaysAllow ?? []).not.toContain("connector:github");
  expect((await record()).tasks.find((task: any) => task.threadId === second).alwaysAllow).toContain("connector:github");
  const listed = (await api("GET", `/api/bots/${dog.id}/always-allowed`)).body.items.find((item: any) => item.kind === "app");
  expect(listed).toMatchObject({ kind: "app", subject: "github", state: "active" });
  expect((await api("DELETE", `/api/bots/${dog.id}/always-allowed/${encodeURIComponent(listed.id)}`)).status).toBe(200);
  expect((await record()).tasks.find((task: any) => task.threadId === second).alwaysAllow ?? []).not.toContain("connector:github");
}, 60_000);

it("Allow once on a connected-app card that always asks covers that call only, so the app's next asking call shows its own card", async () => {
  await autoReview(true);
  const dog = await newDog("Once only", "ask");
  const token = await mintConnectors(dog.id, dog.threadId);
  const before = relayed.length;
  const deleted = relay(token, "GITHUB_DELETE_A_REPOSITORY", { owner: "o", repo: "r" });
  await expect.poll(async () => (await sendCards(dog.threadId)).length, { timeout: 10_000 }).toBe(1);
  const [first] = await sendCards(dog.threadId);
  expect(first.card.lasting).toEqual({ offered: false, why: "always-asks" });
  await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: first.card.requestId, behavior: "allow" });
  expect((await deleted).body.result.isError).toBeFalsy();
  expect(relayed).toHaveLength(before + 1);
  const commented = relay(token, "GITHUB_CREATE_AN_ISSUE_COMMENT", { owner: "o", repo: "r", issue_number: 1, body: "Thanks." });
  await expect.poll(async () => (await sendCards(dog.threadId)).length, { timeout: 10_000, message: "the comment ran on the delete's Allow once" }).toBe(2);
  const second = (await sendCards(dog.threadId)).at(-1);
  expect(second.card.tool).toBe("GITHUB_CREATE_AN_ISSUE_COMMENT");
  expect(relayed).toHaveLength(before + 1);
  await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: second.card.requestId, behavior: "deny" });
  expect((await commented).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before + 1);
}, 60_000);

const DELETES_OR_SHARES = [
  ["GMAIL_DELETE_MESSAGE", { message_id: "m-1" }],
  ["GMAIL_MOVE_TO_TRASH", { message_id: "m-2" }],
  ["GOOGLEDRIVE_DELETE_FILE", { file_id: "f-1" }],
  ["GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE", { file_id: "f-2", role: "writer", type: "anyone" }],
  ["GITHUB_ADD_A_REPOSITORY_COLLABORATOR", { owner: "o", repo: "r", username: "stranger" }],
  ["GITHUB_DELETE_A_REPOSITORY", { owner: "o", repo: "r" }],
  ["NOTION_ARCHIVE_PAGE", { page_id: "p-1" }],
] as const;

it.each(["ask", "auto"] as const)("a connected-app call that deletes something or changes who can reach it shows a card with no Always in %s, whatever the app's old Always or this turn's Allow", async (mode) => {
  await autoReview(false);
  const dog = await newDog(`Tidier ${mode}`, mode);
  const kept = await api("PATCH", `/api/bots/${dog.id}`, { alwaysAllow: ["connector:gmail", "connector:googledrive", "connector:github", "connector:notion"] });
  expect(kept.status, JSON.stringify(kept.body)).toBe(200);
  const token = await mintConnectors(dog.id, dog.threadId);
  for (const [slug, args] of DELETES_OR_SHARES) {
    const before = relayed.length;
    const shown = (await sendCards(dog.threadId)).length;
    const asked = relay(token, slug, args);
    await expect.poll(async () => (await sendCards(dog.threadId)).length, { timeout: 10_000, message: `${mode} ${slug} showed no card` }).toBe(shown + 1);
    const card = (await sendCards(dog.threadId)).at(-1).card;
    expect(card.tool).toBe(slug);
    expect(card.allowKey).toBeUndefined();
    expect(card.lasting).toEqual({ offered: false, why: "always-asks" });
    expect(relayed).toHaveLength(before);
    expect((await api("POST", `/api/bots/${dog.id}/always-allow`, { threadId: dog.threadId, allowKey: `connector:${slug.slice(0, slug.indexOf("_")).toLowerCase()}` })).status).toBe(409);
    await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: card.requestId, behavior: "allow" });
    expect((await asked).body.result.isError).toBeFalsy();
    expect(relayed).toHaveLength(before + 1);
  }
}, 120_000);

it("a delete inside a batch of connected-app calls, and code later.dog cannot read, each show a card with no Always for an owner dog", async () => {
  await autoReview(false);
  const dog = await newDog("Batcher", "auto");
  const token = await mintConnectors(dog.id, dog.threadId);
  for (const [name, args] of [
    ["COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }, { tool_slug: "GITHUB_DELETE_A_REPOSITORY", arguments: { owner: "o", repo: "r" } }] }],
    ["COMPOSIO_PROXY_EXECUTE", { endpoint: "/repos/o/r", method: "DELETE" }],
  ] as const) {
    const before = relayed.length;
    const shown = (await sendCards(dog.threadId)).length;
    const asked = relay(token, name, args);
    await expect.poll(async () => (await sendCards(dog.threadId)).length, { timeout: 10_000, message: `${name} showed no card` }).toBe(shown + 1);
    const card = (await sendCards(dog.threadId)).at(-1).card;
    expect(card.allowKey).toBeUndefined();
    expect(card.lasting).toEqual({ offered: false, why: "always-asks" });
    await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: card.requestId, behavior: "deny" });
    expect((await asked).body.result.isError).toBe(true);
    expect(relayed).toHaveLength(before);
  }
}, 60_000);

it("a share named by a noun, and an archive the word list hid, each show a card with no Always for an owner dog", async () => {
  await autoReview(false);
  const dog = await newDog("Sharer", "auto");
  const token = await mintConnectors(dog.id, dog.threadId);
  for (const [slug, args] of [
    ["GOOGLECALENDAR_ACL_INSERT", { calendar_id: "primary", role: "writer", scope_type: "user", scope_value: "stranger@example.com" }],
    ["BOX_CREATE_COLLABORATION", { item_id: "f-1", item_type: "file", accessible_by_login: "stranger@example.com", role: "editor" }],
    ["SLACK_SET_SLACK_LIST_ACCESS", { list_id: "L1", access_level: "write", user_ids: ["U9"] }],
    ["TRELLO_ARCHIVE_ALL_LIST_CARDS", { idList: "l-1" }],
  ] as const) {
    const before = relayed.length;
    const shown = (await sendCards(dog.threadId)).length;
    const asked = relay(token, slug, args);
    await expect.poll(async () => (await sendCards(dog.threadId)).length, { timeout: 10_000, message: `${slug} showed no card` }).toBe(shown + 1);
    const card = (await sendCards(dog.threadId)).at(-1).card;
    expect(card.tool).toBe(slug);
    expect(card.lasting).toEqual({ offered: false, why: "always-asks" });
    await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: card.requestId, behavior: "deny" });
    expect((await asked).body.result.isError).toBe(true);
    expect(relayed).toHaveLength(before);
  }
}, 60_000);

it("a delete inside a batch whatever its capitals, a batch inside a batch, and the workbench inside a batch each show a card with no Always for an owner dog", async () => {
  await autoReview(false);
  const dog = await newDog("Nester", "auto");
  const token = await mintConnectors(dog.id, dog.threadId);
  for (const args of [
    { tools: [{ tool_slug: "gmail_delete_message", arguments: { message_id: "m-1" } }] },
    { tools: [{ tool_slug: "GoogleDrive_Delete_File", arguments: { file_id: "f-1" } }] },
    { tools: [{ tool_slug: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GITHUB_DELETE_A_REPOSITORY", arguments: { owner: "o", repo: "r" } }] } }] },
    { tools: [{ tool_slug: "COMPOSIO_REMOTE_WORKBENCH", arguments: { code: "run()" } }] },
  ]) {
    const label = JSON.stringify(args).slice(0, 80);
    const before = relayed.length;
    const shown = (await sendCards(dog.threadId)).length;
    const asked = relay(token, "COMPOSIO_MULTI_EXECUTE_TOOL", args);
    await expect.poll(async () => (await sendCards(dog.threadId)).length, { timeout: 10_000, message: `${label} showed no card` }).toBe(shown + 1);
    const card = (await sendCards(dog.threadId)).at(-1).card;
    expect(card.allowKey, label).toBeUndefined();
    expect(card.lasting, label).toEqual({ offered: false, why: "always-asks" });
    await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: card.requestId, behavior: "allow" });
    expect((await asked).body.result.isError, label).toBeFalsy();
    expect(relayed, label).toHaveLength(before + 1);
  }
}, 60_000);

it("a padded or oddly shaped delete, in a batch or on a direct call, shows a card with no Always for an owner dog, and a plain read in a batch runs", async () => {
  await autoReview(false);
  const dog = await newDog("Padder", "auto");
  const token = await mintConnectors(dog.id, dog.threadId);
  const rows: Array<[string, unknown]> = [
    ...[" GMAIL_DELETE_MESSAGE", "GMAIL_DELETE_MESSAGE ", "GMAIL_DELETE_MESSAGE\n", "gmail-delete-message", "GmailDeleteMessage", "gmail.delete_message", "mcp__gmail__GMAIL_DELETE_MESSAGE"]
      .map((slug): [string, unknown] => ["COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: slug, arguments: { message_id: "m-1" } }] }]),
    ["COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: " COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GMAIL_DELETE_MESSAGE", arguments: { message_id: "m-1" } }] } }] }],
    [" GMAIL_DELETE_MESSAGE", { message_id: "m-1" }],
  ];
  for (const [name, args] of rows) {
    const label = JSON.stringify([name, args]).slice(0, 120);
    const before = relayed.length;
    const shown = (await sendCards(dog.threadId)).length;
    const asked = relay(token, name, args);
    await expect.poll(async () => (await sendCards(dog.threadId)).length, { timeout: 10_000, message: `${label} showed no card` }).toBe(shown + 1);
    const card = (await sendCards(dog.threadId)).at(-1).card;
    expect(card.allowKey, label).toBeUndefined();
    expect(card.lasting, label).toEqual({ offered: false, why: "always-asks" });
    expect(relayed, label).toHaveLength(before);
    await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: card.requestId, behavior: "allow" });
    expect((await asked).body.result.isError, label).toBeFalsy();
  }
  const shown = (await sendCards(dog.threadId)).length;
  const read = relayed.length;
  expect((await relay(token, "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }] })).body.result.isError).toBeFalsy();
  expect(relayed).toHaveLength(read + 1);
  expect(await sendCards(dog.threadId)).toHaveLength(shown);
}, 90_000);

it("a Gmail change that adds TRASH in a nested list, in a comma list, or as labelIds shows a card for an owner dog, and STARRED or removing TRASH runs", async () => {
  await autoReview(false);
  const dog = await newDog("Deep labeller", "auto");
  const token = await mintConnectors(dog.id, dog.threadId);
  for (const args of [{ thread_id: "t-1", add_label_ids: "STARRED,IMPORTANT" }, { thread_id: "t-1", remove_label_ids: [["TRASH"]] }]) {
    const ran = relayed.length;
    expect((await relay(token, "GMAIL_MODIFY_THREAD_LABELS", args)).body.result.isError, JSON.stringify(args)).toBeFalsy();
    expect(relayed, JSON.stringify(args)).toHaveLength(ran + 1);
  }
  expect(await sendCards(dog.threadId)).toHaveLength(0);
  for (const args of [{ thread_id: "t-1", add_label_ids: [["TRASH"]] }, { thread_id: "t-1", add_label_ids: "INBOX,TRASH" }, { thread_id: "t-1", labelIds: ["TRASH"] }]) {
    const label = JSON.stringify(args);
    const before = relayed.length;
    const shown = (await sendCards(dog.threadId)).length;
    const asked = relay(token, "GMAIL_MODIFY_THREAD_LABELS", args);
    await expect.poll(async () => (await sendCards(dog.threadId)).length, { timeout: 10_000, message: `${label} showed no card` }).toBe(shown + 1);
    const card = (await sendCards(dog.threadId)).at(-1).card;
    expect(card.lasting, label).toEqual({ offered: false, why: "always-asks" });
    expect(relayed, label).toHaveLength(before);
    await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: card.requestId, behavior: "allow" });
    expect((await asked).body.result.isError, label).toBeFalsy();
  }
}, 60_000);

it("a Gmail change that adds the TRASH label shows a card with no Always, and one that adds another label runs, for an owner dog", async () => {
  await autoReview(false);
  const dog = await newDog("Labeller", "auto");
  const token = await mintConnectors(dog.id, dog.threadId);
  const starred = relayed.length;
  expect((await relay(token, "GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["m-1"], addLabelIds: ["STARRED"] })).body.result.isError).toBeFalsy();
  expect(relayed).toHaveLength(starred + 1);
  expect(await sendCards(dog.threadId)).toHaveLength(0);
  const before = relayed.length;
  const asked = relay(token, "GMAIL_BATCH_MODIFY_MESSAGES", { messageIds: ["m-1"], addLabelIds: ["TRASH"] });
  await expect.poll(async () => (await sendCards(dog.threadId)).length, { timeout: 10_000, message: "the TRASH label showed no card" }).toBe(1);
  const [card] = await sendCards(dog.threadId);
  expect(card.card.lasting).toEqual({ offered: false, why: "always-asks" });
  await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  expect((await asked).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
}, 60_000);

it("an update that makes something public or archives it shows a card with no Always, and an ordinary update runs, for an owner dog", async () => {
  await autoReview(false);
  const dog = await newDog("Updater", "auto");
  const token = await mintConnectors(dog.id, dog.threadId);
  const plain = relayed.length;
  expect((await relay(token, "GITHUB_UPDATE_A_REPOSITORY", { owner: "o", repo: "r", description: "Notes" })).body.result.isError).toBeFalsy();
  expect((await relay(token, "NOTION_UPDATE_PAGE", { page_id: "p-1", archived: false })).body.result.isError).toBeFalsy();
  expect(relayed).toHaveLength(plain + 2);
  expect(await sendCards(dog.threadId)).toHaveLength(0);
  for (const [slug, args] of [
    ["GITHUB_UPDATE_A_REPOSITORY", { owner: "o", repo: "r", visibility: "public" }],
    ["NOTION_UPDATE_PAGE", { page_id: "p-1", archived: true }],
    ["TRELLO_UPDATE_CARDS_BY_ID_CARD", { idCard: "c-1", closed: true }],
  ] as const) {
    const before = relayed.length;
    const shown = (await sendCards(dog.threadId)).length;
    const asked = relay(token, slug, args);
    await expect.poll(async () => (await sendCards(dog.threadId)).length, { timeout: 10_000, message: `${slug} showed no card` }).toBe(shown + 1);
    const card = (await sendCards(dog.threadId)).at(-1).card;
    expect(card.lasting).toEqual({ offered: false, why: "always-asks" });
    await api("POST", `/api/threads/${dog.threadId}/respond`, { requestId: card.requestId, behavior: "deny" });
    expect((await asked).body.result.isError).toBe(true);
    expect(relayed).toHaveLength(before);
  }
}, 60_000);

it("a read, and an ordinary create, through a connected app still run with no card for an owner dog", async () => {
  await autoReview(false);
  const dog = await newDog("Reader", "auto");
  const token = await mintConnectors(dog.id, dog.threadId);
  for (const [slug, args] of [
    ["GMAIL_FETCH_EMAILS", { query: "from:me" }],
    ["GITHUB_LIST_REPOSITORY_COLLABORATORS", { owner: "o", repo: "r" }],
    ["GOOGLEDRIVE_GET_PERMISSION", { file_id: "f-1", permission_id: "p" }],
    ["GOOGLEDRIVE_CREATE_FOLDER", { name: "Notes" }],
  ] as const) {
    const before = relayed.length;
    const answer = await relay(token, slug, args);
    expect(answer.body.result.isError, slug).toBeFalsy();
    expect(relayed, slug).toHaveLength(before + 1);
  }
  expect(await sendCards(dog.threadId)).toHaveLength(0);
}, 60_000);

it("with Auto-review on, every owner dog runs under the engine's reviewer, which sees the standing grant, and what it leaves for the person becomes one card", async () => {
  await autoReview(true);
  const once = await newDog("Careful", "ask");
  const turn = await startTurn(once, "Commit the fix to main.");
  expect(turn.launch.argv[turn.launch.argv.indexOf("--permission-mode") + 1]).toBe("auto");
  expect(turn.launch.settings.autoMode.allow[0]).toBe("$defaults");
  expect(turn.launch.settings.autoMode.allow[1]).toMatch(/^Owner Standing Authorization \(later\.dog\): Jacob has given this agent a standing authorization/);
  expect(turn.launch.settings.autoMode.environment[0]).toBe("$defaults");
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
  const opened = await fetch(`${base}/api/internal/coordinate-bots`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ botIds: [worker.id], message: "Jacob says: commit the fix to main, push it and ship the beta OTA update." }),
  });
  const body = await opened.json() as { receipts: Array<{ threadId: string }> };
  expect(opened.status, JSON.stringify(body)).toBe(200);
  writeFileSync(join(coordinating.launch.cwd, ".release-turn"), "");
  const turn = await attach(worker, body.receipts[0]!.threadId);
  expect(JSON.stringify(turn.launch.prompt)).toContain("one of Jacob's own dogs, passing on Jacob's instructions");
  expect(JSON.stringify(turn.launch.prompt)).not.toContain("not from your user");
  expect(turn.launch.argv[turn.launch.argv.indexOf("--permission-mode") + 1]).toBe("default");
  const push = turn.ask("Bash", { command: "git push origin main" });
  await expect.poll(() => turn.answers.get(push)?.behavior, { timeout: 10_000 }).toBe("allow");
  expect(await turn.card(push)).toBeUndefined();
  await turn.stop();
}, 90_000);
