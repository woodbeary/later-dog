import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudPairingSignature } from "../cloud-home.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";
import { GOOGLE_NEEDS_CLIENT } from "../routes/google.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const MACHINE = "h0123456789abcdef01234567";
const HOST = `${MACHINE}-home.later.dog`;
const ROUTE_TOKEN = randomBytes(32).toString("base64url");
const SHARED = { clientId: "123456-shared.apps.googleusercontent.com", redirectUri: "https://accounts.later.dog/google-oauth/callback" };
const EMAIL = "lopez731@gmail.com";
const secret = randomBytes(32).toString("base64url");

interface Seen { url: string; method: string; headers: Record<string, string | string[] | undefined>; body: string }
let home = "";
let base = "";
let child: ChildProcess;
let log = "";
let owner = "";
let fake: Server;
let fakeBase = "";
let mode: "on" | "off" = "on";
const seen: Seen[] = [];
const grants: Array<Record<string, unknown>> = [];
const proxies: ChildProcess[] = [];

function answer(request: Seen): { status: number; body: unknown } {
  const path = new URL(request.url, "http://fake").pathname;
  if (path.startsWith("/internal/")) {
    if (request.headers.authorization !== `Bearer ${ROUTE_TOKEN}`) return { status: 401, body: { error: "Unauthorized" } };
    if (path === "/internal/client") return mode === "on" ? { status: 200, body: SHARED } : { status: 404, body: { error: "later.dog's Google connection isn't switched on yet." } };
    if (path === "/internal/token" && request.method === "POST") {
      const grant = JSON.parse(request.body) as Record<string, unknown>;
      grants.push(grant);
      if (grant.grant === "code") return { status: 200, body: { access_token: "at-e2e-code", expires_in: 3599, scope: "openid email https://www.googleapis.com/auth/gmail.readonly", refresh_token: "rt-e2e-shared" } };
      if (grant.grant === "refresh" && grant.refreshToken === "rt-e2e-shared") return { status: 200, body: { access_token: "at-e2e-refresh", expires_in: 3599, scope: "openid email" } };
      return { status: 400, body: { error: "Google no longer accepts this connection. Connect again." } };
    }
  }
  const outbound = new URL(request.url, "http://fake").searchParams.get("url") ?? "";
  if (outbound === "https://openidconnect.googleapis.com/v1/userinfo") return { status: 200, body: { email: EMAIL } };
  if (outbound.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) {
    return request.headers.authorization === "Bearer at-e2e-refresh" ? { status: 200, body: { messages: [{ id: "msg001" }] } } : { status: 401, body: {} };
  }
  if (outbound.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/msg001")) {
    return { status: 200, body: { id: "msg001", threadId: "t1", internalDate: String(Date.now()), payload: { headers: [{ name: "From", value: "no-reply@nextdoor.com" }, { name: "Subject", value: "Welcome" }] } } };
  }
  return { status: 503, body: { error: "offline fixture" } };
}

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
  return { call: (name: string, args: unknown = {}) => request("tools/call", { name, arguments: args }) };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "laterdog-google-shared-"));
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
  fake = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const entry: Seen = { url: request.url ?? "", method: request.method ?? "GET", headers: request.headers, body: raw };
      seen.push(entry);
      const { status, body } = answer(entry);
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const address = fake.address();
  fakeBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const prelude = `data:text/javascript,${encodeURIComponent(`const real = globalThis.fetch; globalThis.fetch = async (url, init) => { const target = String(url instanceof Request ? url.url : url); return target.startsWith("http://127.0.0.1:") ? real(url, init) : real(${JSON.stringify(fakeBase)} + "/outbound?url=" + encodeURIComponent(target), init); };`)}`;
  child = spawn(process.execPath, ["--import", prelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, LATERDOG_HOME: dataDir, LATERDOG_SERVER_PORT: String(port), LATERDOG_WEBHOOK_PORT: String(port + 1),
      LATERDOG_CLOUD_ROLE: "home", LATERDOG_CLOUD_MACHINE_ID: MACHINE, LATERDOG_CLOUD_ADMIN_URL: "https://accounts.example.test",
      LATERDOG_CLOUD_BOOTSTRAP_SECRET: secret, LATERDOG_PUBLIC_URL: `https://${HOST}`,
      LATERDOG_CLOUD_GOOGLE_URL: `${fakeBase}/internal`, LATERDOG_CLOUD_GOOGLE_TOKEN: ROUTE_TOKEN,
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
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  await new Promise<void>((resolve) => fake?.close(() => resolve()));
  if (home) await removeTempDir(home);
});

it("a dog on a Cloud home with nothing set up connects Gmail through later.dog's one client and reads it", async () => {
  const bot = (await api("POST", "/api/bots", { token: owner, body: { name: "Scout", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
  const tools = await toolsFor(async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { token: owner, body: { text: "Read my latest Nextdoor email." } })).status).toBe(202);
  });

  const connected = await tools.call("connect_google", { account: EMAIL });
  expect(connected.isError, JSON.stringify(connected)).toBeFalsy();
  expect(connected.content[0].text).toContain("Connect Google card");
  const card = (await api("GET", `/api/threads/${bot.threadId}/messages`, { token: owner })).body.messages.find((message: any) => message.card?.deviceApproval)?.card;
  const link = new URL(card.deviceApproval.url);
  expect(link.searchParams.get("client_id")).toBe(SHARED.clientId);
  expect(link.searchParams.get("redirect_uri")).toBe(SHARED.redirectUri);
  const state = link.searchParams.get("state")!;
  expect(/^(h[0-9a-f]{24})\.[A-Za-z0-9_-]{16,128}$/.exec(state)?.[1]).toBe(MACHINE);

  const page = await fetch(`${base}/google-oauth/callback?state=${encodeURIComponent(state)}&code=auth-code-e2e`, { headers: { host: HOST, "x-forwarded-for": "198.51.100.4", "x-forwarded-proto": "https" } });
  const html = await page.text();
  expect(page.status, html).toBe(200);
  expect(html).toContain(`Connected ${EMAIL}`);
  expect(grants[0]).toMatchObject({ grant: "code", code: "auth-code-e2e" });
  expect(createHash("sha256").update(String(grants[0]!.verifier)).digest("base64url")).toBe(link.searchParams.get("code_challenge"));

  const found = await tools.call("gmail_search", { query: "from:nextdoor.com" });
  expect(found.isError, JSON.stringify(found)).toBeFalsy();
  expect(found.content[0].text).toContain("msg001");
  expect(grants.slice(1)).toEqual([{ grant: "refresh", refreshToken: "rt-e2e-shared" }]);

  const listed = await tools.call("connect_google", { list: true });
  expect(listed.content[0].text).toContain(EMAIL);
  expect(JSON.stringify(found)).not.toContain("rt-e2e-shared");

  for (const request of seen) {
    const text = JSON.stringify(request);
    expect(text, request.url).not.toContain("client_secret");
    expect(text, request.url).not.toContain(encodeURIComponent("https://oauth2.googleapis.com"));
  }
  expect(log).not.toMatch(/rt-e2e-shared|at-e2e-|auth-code-e2e/);

  mode = "off";
  const off = await tools.call("connect_google", { account: EMAIL });
  expect(off.isError).toBe(true);
  expect(off.content[0].text).toBe(`${GOOGLE_NEEDS_CLIENT} Redirect address: https://${HOST}/google-oauth/callback`);
}, 90_000);
