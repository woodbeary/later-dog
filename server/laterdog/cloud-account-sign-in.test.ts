import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cloudPairingSignature } from "../cloud-home.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";
import { chatgptPlanSignIn } from "./cloud-chatgpt.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-login-cli.ts");
const FAKE_GROK = join(SERVER_DIR, "testing", "fake-grok-login-cli.ts");
const FAKE_CURSOR = join(SERVER_DIR, "testing", "fake-cursor-login-cli.ts");
const HOST = "laterdog-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
const fixture = { LATERDOG_DEVICE_AUTH_FIXTURE: "1" };
let home: string;
let base: string;
let child: ChildProcess;
let log = "";
let ownerToken = "";

async function api(method: string, path: string, options: { body?: unknown; headers?: Record<string, string>; anonymous?: boolean } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https",
      ...(ownerToken && !options.anonymous ? { authorization: `Bearer ${ownerToken}` } : {}),
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> };
}

const instance = async (id: string) => (await api("GET", "/api/instances")).body.instances.find((row: { instanceId: string }) => row.instanceId === id);

describe("which ChatGPT sign-in a server offers", () => {
  it("is the browser on a Mac and Codex's device code on a Cloud home", () => {
    expect(chatgptPlanSignIn(false)).toBe("browser");
    expect(chatgptPlanSignIn(true)).toBe("device-code");
  });
});

describe.skipIf(process.platform === "win32")("account sign-in on a Cloud home, through its proxy", () => {
  beforeAll(async () => {
    for (const fake of [FAKE_CODEX, FAKE_GROK, FAKE_CURSOR]) chmodSync(fake, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-cloud-accounts-"));
    const dataDir = join(home, ".laterdog");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      instances: {
        ...Object.fromEntries(["codex", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
        chatgpt: { driver: "codex", displayName: "ChatGPT plan", environment: fixture, config: { authMode: "chatgpt-plan", cli: FAKE_CODEX } },
        grok: { driver: "grokAgent", displayName: "Grok", environment: { ...fixture, FAKE_GROK_MODE: "approve" }, config: { cli: FAKE_GROK } },
        cursor: { driver: "cursorAgent", displayName: "Cursor", environment: { ...fixture, FAKE_CURSOR_MODE: "approve" }, config: { cli: FAKE_CURSOR } },
      },
    }));
    mkdirSync(join(home, "web"));
    writeFileSync(join(home, "web", "index.html"), "<!doctype html><title>later.dog</title>");
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    const offlinePrelude = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
    child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        PATH: process.env.PATH,
        HOME: home, USERPROFILE: home, LATERDOG_HOME: dataDir, LATERDOG_SERVER_PORT: String(port), LATERDOG_WEBHOOK_PORT: String(port + 1), LATERDOG_STATIC_DIR: join(home, "web"),
        LATERDOG_CLOUD_ROLE: "home", LATERDOG_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", LATERDOG_CLOUD_ADMIN_URL: "https://cloud.example.test",
        LATERDOG_CLOUD_BOOTSTRAP_SECRET: secret, LATERDOG_PUBLIC_URL: `https://${HOST}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { log += chunk; });
    child.stderr?.on("data", (chunk) => { log += chunk; });
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
      try { if ((await (await fetch(`${base}/api/health`)).json() as { pid?: number }).pid === child.pid) break; } catch {}
      if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const body = JSON.stringify({ label: "later.dog app (Cloud)", ttlSeconds: 300 });
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
    const granted = await api("POST", "/api/cloud/pairing", { anonymous: true, body: JSON.parse(body), headers: {
      "x-laterdog-cloud-timestamp": timestamp, "x-laterdog-cloud-nonce": nonce,
      "x-laterdog-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
    } });
    ownerToken = (await api("POST", "/api/auth/pair", { anonymous: true, body: { code: granted.body.code } })).body.token as string;
    expect(ownerToken).toBeTruthy();
  }, 30_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it("lists ChatGPT as a device-code sign-in with sign-out, not the desktop browser flow", async () => {
    await vi.waitFor(async () => expect((await instance("chatgpt"))?.snapshot?.state).toBe("available"), { timeout: 15_000, interval: 200 });
    const chatgpt = await instance("chatgpt");
    expect(chatgpt).toMatchObject({ driverKind: "codex", authentication: { method: "device-code", signOut: true }, snapshot: { authenticated: false } });
    expect(chatgpt.snapshot.authenticationUnavailableReason).toBeUndefined();
  });

  it("gives the ChatGPT tile a Codex device code through the proxy instead of a 403, finishes, and signs out", async () => {
    const started = await api("POST", "/api/instances/chatgpt/auth/start");
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.auth).toMatchObject({ phase: "waiting", authorizationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-12345" });
    writeFileSync(join(home, ".laterdog-fake-codex-login-approved"), "approve fixture only\n");
    await vi.waitFor(async () => {
      expect((await api("GET", `/api/instances/chatgpt/auth/status?flowId=${started.body.auth.flowId}`)).body.auth.phase).toBe("succeeded");
    }, { timeout: 10_000, interval: 200 });
    expect((await instance("chatgpt")).snapshot.authenticated).toBe(true);
    const signedOut = await api("POST", "/api/instances/chatgpt/auth/sign-out");
    expect(signedOut.status, JSON.stringify(signedOut.body)).toBe(200);
    expect(existsSync(join(home, ".laterdog-fake-codex-authenticated"))).toBe(false);
    expect((await instance("chatgpt")).snapshot.authenticated).toBe(false);
  });

  it("signs Grok in with xAI's code and out again", async () => {
    await vi.waitFor(async () => expect((await instance("grok"))?.snapshot?.state).toBe("available"), { timeout: 15_000, interval: 200 });
    expect(await instance("grok")).toMatchObject({ authentication: { method: "device-code", signOut: true } });
    const started = await api("POST", "/api/instances/grok/auth/start");
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.auth).toMatchObject({ phase: "waiting", authorizationUrl: "https://accounts.x.ai/device", userCode: "WDJB-MJHT" });
    writeFileSync(join(home, ".laterdog-fake-grok-approved"), "approve fixture only\n");
    await vi.waitFor(async () => {
      expect((await api("GET", `/api/instances/grok/auth/status?flowId=${started.body.auth.flowId}`)).body.auth.phase).toBe("succeeded");
    }, { timeout: 10_000, interval: 200 });
    expect((await instance("grok")).snapshot.authenticated).toBe(true);
    expect((await api("POST", "/api/instances/grok/auth/sign-out")).status).toBe(200);
    expect(existsSync(join(home, ".grok", "auth.json"))).toBe(false);
    expect((await instance("grok")).snapshot.authenticated).toBe(false);
  });

  it("signs Cursor in with Cursor's link and out again", async () => {
    await vi.waitFor(async () => expect((await instance("cursor"))?.snapshot?.state).toBe("available"), { timeout: 15_000, interval: 200 });
    expect(await instance("cursor")).toMatchObject({ authentication: { method: "device-code", signOut: true }, snapshot: { authenticated: false } });
    const started = await api("POST", "/api/instances/cursor/auth/start");
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.auth).toMatchObject({ phase: "waiting", authorizationUrl: expect.stringMatching(/^https:\/\/cursor\.com\/loginDeepControl\?/) });
    expect(started.body.auth.userCode).toBeUndefined();
    writeFileSync(join(home, ".laterdog-fake-cursor-approved"), "approve fixture only\n");
    await vi.waitFor(async () => {
      expect((await api("GET", `/api/instances/cursor/auth/status?flowId=${started.body.auth.flowId}`)).body.auth.phase).toBe("succeeded");
    }, { timeout: 10_000, interval: 200 });
    expect((await instance("cursor")).snapshot.authenticated).toBe(true);
    expect((await api("POST", "/api/instances/cursor/auth/sign-out")).status).toBe(200);
    expect((await instance("cursor")).snapshot.authenticated).toBe(false);
  });
});
