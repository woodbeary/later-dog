import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudPairingSignature } from "../cloud-home.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST = "laterdog-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
let home = "", base = "", log = "", token = "";
let child: ChildProcess | undefined;
const dump = () => join(home, "turn.json");

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}\n${log.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "laterdog-home-cloud-computer-"));
  const dataDir = join(home, ".laterdog");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(dump())};
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi", "claude"].map((id) => [id, { driver: "not-a-real-driver" }])),
      own: { driver: "claudeAgent", displayName: "Own", config: { cli } },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, LATERDOG_HOME: dataDir, LATERDOG_SERVER_PORT: String(port), LATERDOG_WEBHOOK_PORT: String(port + 1),
      LATERDOG_TRIAL_API: "off",
      LATERDOG_CLOUD_ROLE: "home", LATERDOG_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", LATERDOG_CLOUD_ADMIN_URL: "https://cloud.example.test",
      LATERDOG_CLOUD_BOOTSTRAP_SECRET: secret, LATERDOG_PUBLIC_URL: `https://${HOST}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  await until(async () => {
    if (child?.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, Boolean, "the home to start");
  const body = JSON.stringify({ label: "later.dog app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await (await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-laterdog-cloud-timestamp": timestamp, "x-laterdog-cloud-nonce": nonce, "x-laterdog-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body })).json() as { code: string };
  token = (await api("POST", "/api/auth/pair", { code: granted.code })).body.token;
}, 60_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("a new dog on a home whose cloud computers aren't ready yet still answers on the owner's own account", async () => {
  const created = await api("POST", "/api/bots", { name: "Scout", modelSelection: { instanceId: "own", model: "claude-sonnet-5" } });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(400);
  const bot = created.body.bot as { id: string; threadId: string; computer?: string };
  expect(bot.computer).toBe("cloud");

  rmSync(dump(), { force: true });
  const before = ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages as any[]).length;
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "What is 2+2?", threadId: bot.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(400);
  const messages = await until(
    async () => ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages as any[]).slice(before),
    (rows) => rows.some((row) => row.role === "bot" && row.kind === "text") || rows.some((row) => String(row.tool?.name ?? "").startsWith("error:")),
    "the dog's reply",
  );
  expect(messages.filter((row) => String(row.tool?.name ?? "").startsWith("error:"))).toEqual([]);
  const launched = JSON.parse(readFileSync(dump(), "utf8")) as { systemPrompt: string | null; mcpConfig: { mcpServers?: Record<string, unknown> } | null };
  expect(launched.systemPrompt).toContain("cloud computer isn't ready yet");
  expect(launched.mcpConfig?.mcpServers ?? {}).not.toHaveProperty("computer");
}, 60_000);
