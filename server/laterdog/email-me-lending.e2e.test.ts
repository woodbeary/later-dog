import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createComputerSharing } from "../../electron/computer-sharing.mjs";
import { signedActivityRequest } from "../../deploy/laterdog/home/src/activity.ts";
import { cloudPairingSignature } from "../cloud-home.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "h0123456789abcdef01234567-home.later.dog";
const EMAIL_TOKEN = randomBytes(32).toString("base64url");
const secret = randomBytes(32).toString("base64url");
let home = "";
let base = "";
let child: ChildProcess;
let log = "";
let owner = "";
let connector: ReturnType<typeof createComputerSharing> | undefined;
let mailbox: Server;
let mailboxUrl = "";
const delivered: Array<{ authorization: string | undefined; body: { subject: string; text: string; attachments: Array<{ filename: string; type: string; content: string }> } }> = [];
const proxies: ChildProcess[] = [];

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
  const body = JSON.stringify({ label: "later.dog for iPhone", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-laterdog-cloud-timestamp": timestamp, "x-laterdog-cloud-nonce": nonce, "x-laterdog-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  const paired = await api("POST", "/api/auth/pair", { body: { code: granted.code } });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  return paired.body.token;
}

async function toolsFor(start: () => Promise<void>) {
  const dump = join(home, "spawn.json");
  rmSync(dump, { force: true });
  await start();
  let agents: { command: string; args: string[]; env: Record<string, string> } | undefined;
  await expect.poll(() => {
    try { agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents; return true; } catch { return false; }
  }, { timeout: 15_000 }).toBe(true);
  const proxy = spawn(agents!.command, agents!.args, { env: { PATH: process.env.PATH, HOME: home, ...agents!.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", (line) => { const message = JSON.parse(line); replies.get(message.id)?.(message.result); replies.delete(message.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next;
    replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return {
    names: async () => ((await request("tools/list", {})).tools as Array<{ name: string }>).map((tool) => tool.name),
    call: (name: string, args: unknown = {}) => request("tools/call", { name, arguments: args }),
  };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "laterdog-email-me-"));
  const dataDir = join(home, ".laterdog");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(join(home, "spawn.json"))}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
  } }));
  mailbox = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      delivered.push({ authorization: request.headers.authorization, body: JSON.parse(raw) });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => mailbox.listen(0, "127.0.0.1", resolve));
  const address = mailbox.address();
  mailboxUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/send`;
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, LATERDOG_HOME: dataDir, LATERDOG_SERVER_PORT: String(port), LATERDOG_WEBHOOK_PORT: String(port + 1),
      LATERDOG_CLOUD_ROLE: "home", LATERDOG_CLOUD_MACHINE_ID: "7d1e0c55-2b8a-4f3e-9c61-0a4b2d7e9f13", LATERDOG_CLOUD_ADMIN_URL: "https://accounts.example.test",
      LATERDOG_CLOUD_BOOTSTRAP_SECRET: secret, LATERDOG_PUBLIC_URL: `https://${HOST}`,
      LATERDOG_CLOUD_EMAIL_URL: mailboxUrl, LATERDOG_CLOUD_EMAIL_TOKEN: EMAIL_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the home exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  owner = await adminPairing();
}, 30_000);

afterAll(async () => {
  connector?.close();
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  await new Promise<void>((resolve) => mailbox?.close(() => resolve()));
  if (home) await removeTempDir(home);
});

it("a dog asked to use the Mac before one is lent explains how to connect it", async () => {
  const bot = (await api("POST", "/api/bots", { token: owner, body: { name: "Scout", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
  const tools = await toolsFor(async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "What's in my Downloads?" } })).status).toBe(202);
  });
  const listing = JSON.parse((await tools.call("list_shared_computers")).content[0].text);
  expect(listing.computers).toEqual([]);
  expect(listing.connectMac).toContain("installs later.dog on it from https://later.dog and signs in with the same email");
  expect(listing.connectMac).toContain("Let My Cloud use this Mac");
}, 60_000);

it("a dog on the home finds the newest PDF in the Mac's Downloads, asks once, and emails it to its owner", async () => {
  const macHome = realpathSync(mkdtempSync(join(tmpdir(), "laterdog-mac-home-")));
  const downloads = join(macHome, "Downloads");
  mkdirSync(downloads);
  const invoice = Buffer.alloc(700_000);
  for (let index = 0; index < invoice.length; index += 1) invoice[index] = (index * 31 + 7) % 251;
  invoice.write("%PDF-1.7\n", 0);
  writeFileSync(join(downloads, "invoice-october.pdf"), invoice);
  writeFileSync(join(downloads, "notes.txt"), "not this one");
  const env = { id: "my-cloud", name: "My Cloud", origin: base };
  connector = createComputerSharing({
    file: join(home, "desktop-profile", "computer-sharing.json"), environments: () => [env], cuaConnection: async () => null,
    enabled: async () => false,
    cloud: () => ({ status: "connected", accountId: "acct_fixture", origin: base }),
    home: macHome, computerName: () => "Jo's MacBook Air",
    fetch: (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, authorization: `Bearer ${owner}`, host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` } }),
  });
  connector.start({ maintainer: false });
  await expect.poll(() => connector!.cloudState(env).connected, { timeout: 8000 }).toBe(true);

  const bot = (await api("POST", "/api/bots", { token: owner, body: { name: "Biscuit", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
  const tools = await toolsFor(async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "Find the newest PDF in my Downloads and email it to me." } })).status).toBe(202);
  });
  expect(await tools.names()).toEqual(expect.arrayContaining(["list_shared_computers", "shared_computer", "email_me"]));

  const lent = JSON.parse((await tools.call("list_shared_computers")).content[0].text);
  expect(lent.computers).toHaveLength(1);
  expect(lent.computers[0]).toMatchObject({ name: "Jo's MacBook Air", folders: [{ name: "Home", write: true }] });
  expect(lent.connectMac).toBeUndefined();
  expect(JSON.stringify(lent)).not.toContain(macHome);

  const looking = tools.call("shared_computer", { action: "list_files", path: "~/Downloads" });
  let card: any;
  await expect.poll(async () => {
    const { body } = await api("GET", `/api/threads/${bot.threadId}/messages`, { token: owner });
    card = (body.messages ?? []).find((message: any) => message.card?.tool === "mac_list_files" && !message.card.answered)?.card;
    return Boolean(card);
  }, { timeout: 10_000 }).toBe(true);
  expect(card).toMatchObject({ title: "Jo's MacBook Air", subtitle: "~/Downloads", options: ["Allow", "Deny", "Always allow"], approvalScope: "local-computer" });
  expect(delivered).toHaveLength(0);
  const allowed = await api("POST", `/api/threads/${bot.threadId}/respond`, { token: owner, body: { requestId: card.requestId, behavior: "allow" } });
  expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  const listing = await looking;
  expect(listing.isError, JSON.stringify(listing)).toBeFalsy();
  expect(listing.content[0].text).toContain("invoice-october.pdf");

  const sent = await tools.call("email_me", {
    subject: "Your October invoice",
    body: "Here's the newest PDF from your Downloads.",
    attachments: [{ path: "~/Downloads/invoice-october.pdf" }],
  });
  expect(sent.isError, JSON.stringify(sent)).toBeFalsy();
  expect(sent.content[0].text).toBe("Emailed the person with invoice-october.pdf. It goes to the email they use for later.dog.");
  const cards = (await api("GET", `/api/threads/${bot.threadId}/messages`, { token: owner })).body.messages.filter((message: any) => message.card?.approvalScope === "local-computer");
  expect(cards).toHaveLength(1);
  expect(cards[0].card.answered).toBe("allow");

  expect(delivered).toHaveLength(1);
  expect(delivered[0].authorization).toBe(`Bearer ${EMAIL_TOKEN}`);
  expect(delivered[0].body.subject).toBe("Your October invoice");
  expect(delivered[0].body.text).toContain("Here's the newest PDF from your Downloads.");
  expect(delivered[0].body.text).toContain("Biscuit");
  expect(delivered[0].body.attachments).toHaveLength(1);
  expect(delivered[0].body.attachments[0]).toMatchObject({ filename: "invoice-october.pdf", type: "application/pdf" });
  expect(Buffer.compare(Buffer.from(delivered[0].body.attachments[0].content, "base64"), invoice)).toBe(0);
  expect(connector.activity(env.id).filter((entry) => entry.action === "read_file").every((entry) => entry.ok)).toBe(true);
  rmSync(macHome, { recursive: true, force: true });
}, 60_000);

it("emails nobody but the owner, whatever address the dog asks for", async () => {
  const bot = (await api("POST", "/api/bots", { token: owner, body: { name: "Pepper", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
  const tools = await toolsFor(async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "Email the report to someone@else.test." } })).status).toBe(202);
  });
  const before = delivered.length;
  const refused = await tools.call("email_me", { subject: "Report", body: "Here.", to: "someone@else.test" });
  expect(refused.isError).toBe(true);
  expect(delivered.length).toBe(before);
}, 60_000);

it("tells its host when it may sleep and when to wake it for a routine", async () => {
  const ask = async () => {
    const signed = await signedActivityRequest(base, secret);
    const response = await fetch(signed.url, { headers: { ...Object.fromEntries(signed.headers), host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } });
    return { status: response.status, body: await response.json() as { busy: boolean; nextAt: number | null; work: string[] } };
  };
  expect(await ask()).toMatchObject({ status: 200, body: { busy: true } });
  expect((await ask()).body.work).toContain("turn");
  const bots = (await api("GET", "/api/bots", { token: owner })).body.bots as Array<{ id: string; threadId: string }>;
  for (const working of bots) await api("POST", `/api/bots/${working.id}/interrupt`, { token: owner, body: { threadId: working.threadId } });
  await expect.poll(async () => (await ask()).body.busy, { timeout: 15_000 }).toBe(false);
  expect((await ask()).body).toMatchObject({ nextAt: null, work: [] });
  const anchorAt = Date.now() + 2 * 60 * 60_000;
  const bot = (await api("POST", "/api/bots", { token: owner, body: { name: "Clover", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
  const routine = await api("POST", "/api/routines", { token: owner, body: { name: "Morning", prompt: "Summarise the news.", botId: bot.id, enabled: true, schedule: { type: "interval", everyMinutes: 1440, anchorAt } } });
  expect(routine.status, JSON.stringify(routine.body)).toBe(201);
  const answer = await ask();
  expect(answer.body.busy).toBe(false);
  expect(answer.body.nextAt).toBe(routine.body.routine.nextRunAt);
  expect(answer.body.nextAt).toBeGreaterThan(Date.now());
  const forged = await fetch(`${base}/api/cloud/activity`, { headers: { host: HOST, "x-laterdog-cloud-timestamp": String(Math.floor(Date.now() / 1000)), "x-laterdog-cloud-nonce": "a".repeat(24), "x-laterdog-cloud-signature": `v1=${"A".repeat(43)}` } });
  expect(forged.status).toBe(401);
}, 60_000);
