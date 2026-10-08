// Owned full server, disposable data. A deployment configured for hosted
// access whose optional access layer is missing must fail closed: no hosted
// sign-in, no legacy pairing or email credentials, no shared Full policy,
// while the local owner keeps access. later.dog ships no such layer, so what
// needs a loaded one (portal sessions, revocation, readiness attestation) is
// not exercised here; server/enterprise.test.ts covers the hook point itself.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { SessionRegistry } from "./sessions.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let PORT: number;
const HOST = "acme.example.test";
const EMAIL = "member@example.test";
const INSTANCES = { claude: { driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") } } };
let home: string;
let child: ChildProcess;
let log = "";
let pairedToken: string;
let policyBotId: string | undefined;
const policyEvidence: unknown[] = [];

function call(path: string, options: { method?: string; token?: string; local?: boolean; body?: unknown } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: PORT, path, method: options.method ?? "GET", headers: {
      ...(options.local ? {} : { host: HOST, "x-forwarded-for": "203.0.113.8", "x-forwarded-proto": "https" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    } }, (res) => {
      let raw = ""; res.on("data", (chunk) => raw += chunk);
      res.on("end", () => { let body: unknown = raw; try { body = JSON.parse(raw); } catch { /* static HTML */ }
        resolve({ status: res.statusCode!, body }); });
    });
    req.on("error", reject); req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}
async function policyBot() {
  if (policyBotId) return policyBotId;
  const catalog = await call("/api/instances", { local: true });
  const provider = catalog.body.instances.find((instance: any) => instance.instanceId === "claude");
  expect(provider.driverKind).toBe("claudeAgent");
  expect(provider.snapshot.state).not.toBe("unavailable");
  expect(provider.cli).toBe(INSTANCES.claude.config.cli);
  const created = await call("/api/bots", { method: "POST", local: true, body: {
    name: "Hosted policy fixture", requireAvailableModel: true, modelSelection: { instanceId: "claude", model: provider.models.default },
  } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return policyBotId = created.body.bot.id as string;
}
/** Guarded Full access is offered; the shared workspace Full policy is not. */
async function policyHealth() {
  const health = await call("/api/health", { local: true });
  expect(health.status).toBe(200);
  expect(health.body.capabilities.guardedFullAccess).toBe(1);
  expect(health.body.capabilities.sharedWorkspaceFullAccess).toBe(undefined);
  policyEvidence.push({ health: health.body, authenticatedAs: "loopback" });
}
async function refuseFullTask() {
  const botId = await policyBot();
  const bots = async () => (await call("/api/bots?messages=0", { local: true })).body.bots;
  const before = (await bots()).find((bot: any) => bot.id === botId);
  const denied = await call(`/api/bots/${botId}/tasks`, { method: "POST", local: true,
    body: { title: "Must not become Full", approvalMode: "full" } });
  expect(denied.status, JSON.stringify(denied.body)).toBe(403);
  expect((await bots()).find((bot: any) => bot.id === botId)).toEqual(before);
  policyEvidence.push({ deniedFullTask: denied.body, status: denied.status, authenticatedAs: "loopback" });
}

beforeAll(async () => {
  PORT = await freePortBlock([0, 1], 35_000, 5_000);
  home = mkdtempSync(join(tmpdir(), "laterdog-hosted-server-"));
  const data = join(home, ".laterdog");
  mkdirSync(join(home, "static"));
  writeFileSync(join(home, "static", "index.html"), "<!doctype html><title>Fixture workspace</title>");
  const sessions = new SessionRegistry({ file: join(data, "sessions.json") });
  pairedToken = sessions.issue({ label: "Pre-existing QR device", scopes: ["admin", "client"] }).token;
  writeFileSync(join(data, "config.json"), JSON.stringify({ signIn: { admins: [EMAIL] }, instances: INSTANCES }));
  child = spawn(process.execPath, [join(ROOT, "server/index.ts")], { cwd: ROOT, env: {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home, LATERDOG_SERVER_PORT: String(PORT), LATERDOG_WEBHOOK_PORT: String(PORT + 1),
    LATERDOG_STATIC_DIR: join(home, "static"), LATERDOG_BROWSER_CONNECTION: join(home, "browser-connection.json"),
    // A complete portal-managed configuration with a key, naming a layer
    // folder that does not exist.
    LATERDOG_ENTERPRISE_DIR: join(home, "absent-layer"), LATERDOG_LICENSE_KEY: "fixture-only",
    LATERDOG_ADMIN_URL: "https://admin.example.test", LATERDOG_ADMIN_WORKSPACE: "acme", LATERDOG_PUBLIC_URL: `https://${HOST}`,
    LATERDOG_ADMIN_MEMBERSHIP: "portal", LATERDOG_SHARED_WORKSPACE_FULL_ACCESS: "1",
    // The fixture is driven over loopback, so it keeps the owner explicitly.
    LATERDOG_LOOPBACK_TRUST: "owner",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => log += chunk); child.stderr?.on("data", (chunk) => log += chunk);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await call("/api/health", { local: true })).status === 200) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Owned hosted fixture failed to start:\n${log}`);
}, 30_000);
afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  const evidenceDir = join(tmpdir(), "laterdog-verification-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `hosted-access-${Date.now()}-${process.pid}.log`);
  writeFileSync(logPath, log);
  writeFileSync(`${logPath}.json`, JSON.stringify(policyEvidence, null, 2));
  console.info(JSON.stringify({ logPath, evidencePath: `${logPath}.json` }));
  await removeTempDir(home);
});

describe("hosted access in the full server, without its access layer", () => {
  it("fails closed if a configured deployment loses its enterprise hook, with local owner access retained", async () => {
    await policyHealth();
    await refuseFullTask();
    expect((await call("/api/health/hosted")).status).toBe(503);
    expect((await call("/api/auth/hosted/start")).status).toBe(503);
    expect((await call("/")).status).toBe(503);
    expect((await call("/pair")).status).toBe(503);
    expect((await call("/api/auth/session", { token: pairedToken })).status).toBe(503);
    expect((await call("/api/auth/email/verify", { method: "POST" })).status).toBe(403);
    expect((await call("/api/auth/session", { local: true })).body.kind).toBe("loopback");
  }, 25_000);
});
