import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import { sha256 } from "../src/installations";

const BASE = "https://auth.laterdog.test";
const INSTALLATION = "/api/cloud/desktop/workspace/installation";
const HEARTBEAT = "/api/cloud/desktop/workspace";
const WORKSPACE = "/api/cloud/workspace";
const ORIGIN = "https://c-0123456789abcdef0123456789abcdef.later.dog";
const CREDENTIAL = `laterdog_pair_${"a".repeat(43)}`;

type Registration = { installation: { id: string }; credential: string; credentialExpiresAt: number };
type Resolution = { account: { id: string }; workspace: null | { state: string; origin?: string; pairing?: { credential: string; requestId: string; expiresAt: number } } };

function harness() {
  const worker = createWorker(fetch, () => null);
  async function call(path: string, token?: string, body: unknown = {}, method = "POST") {
    const headers = new Headers({ "content-type": "application/json", "cf-connecting-ip": "203.0.113.55" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${BASE}${path}`, {
      method, headers, ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body) }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  async function account(email = "workspace@example.com") {
    const ctx = createExecutionContext();
    const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
    const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
    await waitOnExecutionContext(ctx);
    const response = await call("/api/auth/sign-in/email-otp", undefined, { email, otp });
    expect(response.status).toBe(200);
    const data = await response.json<{ user: { id: string } }>();
    return { id: data.user.id, token: response.headers.get("set-auth-token")! };
  }
  async function device(accountId: string) {
    const token = `omc_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`;
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO cloud_devices (id, account_id, token_hash, device_name, platform, created_at, expires_at)
       VALUES (?, ?, ?, 'Fixture Mac', 'darwin', ?, ?)`,
    ).bind(id, accountId, await sha256(token), Date.now(), Date.now() + 86_400_000).run();
    return { token, id };
  }
  async function register(token: string, clientInstanceId = "fixture-mac") {
    const response = await call(INSTALLATION, token, { name: "Fixture Mac", platform: "darwin", clientInstanceId });
    expect(response.status).toBe(201);
    return response.json<Registration>();
  }
  async function endpoint(installationId: string, origin = ORIGIN) {
    await env.DB.prepare(
      `INSERT INTO installation_endpoints (installation_id, hostname, tunnel_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'ready', ?, ?)`,
    ).bind(installationId, new URL(origin).hostname, `fixture-${installationId}`, Date.now(), Date.now()).run();
  }
  async function connected(email?: string, origin = ORIGIN) {
    const owner = await account(email);
    const desktop = await device(owner.id);
    const installation = await register(desktop.token);
    await endpoint(installation.installation.id, origin);
    expect((await call(HEARTBEAT, desktop.token, { installationId: installation.installation.id, ready: true })).status).toBe(200);
    return { owner, desktop, installation };
  }
  return { call, account, device, register, endpoint, connected };
}

describe("account workspace access", () => {
  it("keeps every account on its desktop connection path even before a desktop has signed in", async () => {
    const h = harness();
    const owner = await h.account();
    await expect((await h.call(WORKSPACE, owner.token)).json()).resolves.toMatchObject({ workspace: { state: "unlinked" } });
    await h.device(owner.id);
    await expect((await h.call(WORKSPACE, owner.token)).json()).resolves.toMatchObject({ workspace: { state: "unlinked" } });
    expect((await h.call(WORKSPACE)).status).toBe(401);
  });

  it("resolves without allocating, then brokers an idempotent short-lived opaque pairing only to the owning account", async () => {
    const h = harness();
    const { owner, desktop, installation } = await h.connected();
    const first = await (await h.call(WORKSPACE, owner.token)).json<Resolution>();
    expect(first.workspace).toEqual({ state: "ready", origin: ORIGIN });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workspace_pairings").first("n")).toBe(0);
    const requestId = crypto.randomUUID();
    const input = { requestId, label: "Fixture iPhone" };
    await h.call(WORKSPACE, owner.token, input);
    await h.call(WORKSPACE, owner.token, input);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workspace_pairings").first("n")).toBe(1);
    const pending = await (await h.call(HEARTBEAT, desktop.token, { installationId: installation.installation.id, ready: true })).json<{ request: { id: string; expiresAt: number } }>();
    expect(pending.request.id).toBe(requestId);
    const completion = { installationId: installation.installation.id, ready: true, pairing: { requestId, credential: CREDENTIAL, expiresAt: Date.now() + 300_000 } };
    expect((await h.call(HEARTBEAT, desktop.token, completion)).status).toBe(200);
    expect((await h.call(HEARTBEAT, desktop.token, completion)).status).toBe(200);
    const resolved = await (await h.call(WORKSPACE, owner.token, input)).json<Resolution>();
    expect(resolved.workspace?.pairing).toEqual({ requestId, credential: CREDENTIAL, expiresAt: pending.request.expiresAt });
    const other = await h.account("other@example.com");
    const otherResult = await (await h.call(WORKSPACE, other.token, input)).text();
    expect(otherResult).not.toContain(CREDENTIAL);
    expect(otherResult).not.toContain(ORIGIN);
  });

  it("connects separate signed-in accounts only to their own desktop and grants", async () => {
    const h = harness();
    const otherOrigin = "https://c-fedcba9876543210fedcba9876543210.later.dog";
    const first = await h.connected("first@example.com");
    const second = await h.connected("second@example.com", otherOrigin);
    const requestId = crypto.randomUUID();
    const input = { requestId, label: "iPhone" };
    const otherCredential = `laterdog_pair_${"b".repeat(43)}`;
    for (const [connection, credential] of [[first, CREDENTIAL], [second, otherCredential]] as const) {
      expect((await h.call(WORKSPACE, connection.owner.token, input)).status).toBe(200);
      const body = { installationId: connection.installation.installation.id, ready: true };
      const pending = await (await h.call(HEARTBEAT, connection.desktop.token, body)).json<{ request: { id: string } }>();
      expect(pending.request.id).toBe(requestId);
      expect((await h.call(HEARTBEAT, connection.desktop.token, {
        ...body, pairing: { requestId, credential, expiresAt: Date.now() + 60_000 },
      })).status).toBe(200);
    }
    const firstResult = await (await h.call(WORKSPACE, first.owner.token, input)).json<Resolution>();
    const secondResult = await (await h.call(WORKSPACE, second.owner.token, input)).json<Resolution>();
    expect(firstResult).toMatchObject({ account: { id: first.owner.id }, workspace: { origin: ORIGIN, pairing: { credential: CREDENTIAL } } });
    expect(secondResult).toMatchObject({ account: { id: second.owner.id }, workspace: { origin: otherOrigin, pairing: { credential: otherCredential } } });
    expect(JSON.stringify(firstResult)).not.toContain(otherCredential);
    expect(JSON.stringify(secondResult)).not.toContain(CREDENTIAL);
    await env.DB.prepare("UPDATE cloud_devices SET revoked_at = ? WHERE id = ?").bind(Date.now(), first.desktop.id).run();
    await expect((await h.call(WORKSPACE, first.owner.token, input)).json()).resolves.toMatchObject({ workspace: { state: "unlinked" } });
    await expect((await h.call(WORKSPACE, second.owner.token, input)).json()).resolves.toMatchObject({ workspace: { state: "ready", origin: otherOrigin } });
  });

  it("separates account, device and installation credentials and rejects another account's heartbeat", async () => {
    const h = harness();
    const { owner, desktop, installation } = await h.connected();
    expect((await h.call(INSTALLATION, owner.token, {})).status).toBe(401);
    expect((await h.call(INSTALLATION, installation.credential, {})).status).toBe(401);
    expect((await h.call(WORKSPACE, desktop.token)).status).toBe(401);
    expect((await h.call("/v1/installations/self", desktop.token, {}, "GET")).status).toBe(401);
    const other = await h.account("foreign@example.com");
    const foreign = await h.device(other.id);
    expect((await h.call(HEARTBEAT, foreign.token, { installationId: installation.installation.id, ready: true })).status).toBe(409);
    expect((await h.call(HEARTBEAT, desktop.token, { installationId: installation.installation.id, ready: true, origin: "https://evil.example" })).status).toBe(400);
  });

  it("pins the first Mac, preserves its installation across enrollment retries, and rejects a competing Mac", async () => {
    const h = harness();
    const { owner, desktop, installation } = await h.connected();
    const again = await h.register(desktop.token);
    expect(again.installation.id).toBe(installation.installation.id);
    expect(again.credential).not.toBe(installation.credential);
    const second = await h.device(owner.id);
    const refused = await h.call(INSTALLATION, second.token, { name: "Another Mac", platform: "darwin", clientInstanceId: "another-mac" });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toEqual({ error: "workspace_already_linked" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM installations").first("n")).toBe(1);
    expect((await h.call(HEARTBEAT, second.token, { installationId: installation.installation.id, ready: true })).status).toBe(409);
  });

  it("withholds pairing when the Mac stops heartbeating or its endpoint is not ready", async () => {
    const h = harness();
    const { owner, desktop, installation } = await h.connected();
    await env.DB.prepare("UPDATE account_workspaces SET last_seen_at = ?").bind(Date.now() - 61_000).run();
    await expect((await h.call(WORKSPACE, owner.token, { requestId: crypto.randomUUID(), label: "iPhone" })).json()).resolves.toMatchObject({ workspace: { state: "offline" } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workspace_pairings").first("n")).toBe(0);
    await env.DB.prepare("UPDATE installation_endpoints SET status = 'deleted'").run();
    await h.call(HEARTBEAT, desktop.token, { installationId: installation.installation.id, ready: true });
    await expect((await h.call(WORKSPACE, owner.token)).json()).resolves.toMatchObject({ workspace: { state: "offline" } });
  });

  it.each(["device", "installation", "device_expiry"])("invalidates %s access without falling back to Cloud", async (kind) => {
    const h = harness();
    const { owner, desktop, installation } = await h.connected();
    if (kind === "device") await env.DB.prepare("UPDATE cloud_devices SET revoked_at = ?").bind(Date.now()).run();
    if (kind === "installation") await env.DB.prepare("UPDATE installations SET revoked_at = ?").bind(Date.now()).run();
    if (kind === "device_expiry") await env.DB.prepare("UPDATE cloud_devices SET expires_at = ?").bind(Date.now() - 1).run();
    await expect((await h.call(WORKSPACE, owner.token)).json()).resolves.toMatchObject({ workspace: { state: "unlinked" } });
    expect((await h.call(HEARTBEAT, desktop.token, { installationId: installation.installation.id, ready: true })).status).toBe(kind === "installation" ? 409 : 401);
  });

  it("bounds outstanding pairing requests and restarts an expired request ID without retaining credentials", async () => {
    const h = harness();
    const { owner, desktop, installation } = await h.connected();
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    for (const requestId of ids) expect((await h.call(WORKSPACE, owner.token, { requestId, label: "iPhone" })).status).toBe(200);
    expect((await h.call(WORKSPACE, owner.token, { requestId: crypto.randomUUID(), label: "iPhone" })).status).toBe(429);
    const wrong = { installationId: installation.installation.id, ready: true, pairing: { requestId: crypto.randomUUID(), credential: CREDENTIAL, expiresAt: Date.now() + 60_000 } };
    expect((await h.call(HEARTBEAT, desktop.token, wrong)).status).toBe(409);
    await env.DB.prepare("UPDATE workspace_pairings SET expires_at = ?, credential = ?").bind(Date.now() - 1, CREDENTIAL).run();
    expect((await h.call(WORKSPACE, owner.token, { requestId: ids[0], label: "iPhone" })).status).toBe(200);
    const rows = await env.DB.prepare("SELECT credential FROM workspace_pairings").all<{ credential: string | null }>();
    expect(rows.results).toEqual([{ credential: null }]);
  });
});
