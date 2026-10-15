import { z } from "zod";

import { accountSession, type ControlPlaneAuth } from "./auth";
import { requireDevice } from "./cloud";
import { HTTPError, json, readBoundedJSON } from "./http";
import {
  createInstallationForOwner,
  createInstallationSchema,
  installationJSON,
  ownedActiveInstallation,
  rotateInstallationCredentialForOwner,
} from "./installations";

const PAIRING_TTL_MS = 120_000;
const HEARTBEAT_TTL_MS = 60_000;
const MAX_PENDING_PAIRINGS = 4;
const label = z.string().trim().min(1).max(100).regex(/^[^\p{Cc}]+$/u);
const workspaceRequestSchema = z.strictObject({ requestId: z.uuid().optional(), label: label.optional() })
  .refine((input) => Boolean(input.requestId) === Boolean(input.label));
const heartbeatSchema = z.strictObject({
  installationId: z.uuid(),
  ready: z.boolean(),
  pairing: z.strictObject({
    requestId: z.uuid(),
    credential: z.string().regex(/^laterdog_pair_[A-Za-z0-9_-]{43}$/),
    expiresAt: z.number().int().positive(),
  }).optional(),
});

interface WorkspaceRow {
  installation_id: string;
  device_id: string;
  ready: number;
  last_seen_at: number | null;
  client_instance_id: string;
  installation_revoked_at: number | null;
  device_revoked_at: number | null;
  device_expires_at: number;
  endpoint_status: string | null;
  hostname: string | null;
}

interface PairingRow {
  request_id: string;
  label: string;
  credential: string | null;
  credential_expires_at: number | null;
  expires_at: number;
}

async function parse<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const input = schema.safeParse(await readBoundedJSON(request));
  if (!input.success) throw new HTTPError(400, "invalid_request");
  return input.data;
}

async function workspace(env: Env, accountId: string): Promise<WorkspaceRow | null> {
  return env.DB.prepare(
    `SELECT w.installation_id, w.device_id, w.ready, w.last_seen_at, i.client_instance_id,
            i.revoked_at AS installation_revoked_at, d.revoked_at AS device_revoked_at,
            d.expires_at AS device_expires_at, e.status AS endpoint_status, e.hostname
       FROM account_workspaces w
       JOIN installations i ON i.id = w.installation_id AND i.owner_user_id = w.account_id
       JOIN cloud_devices d ON d.id = w.device_id AND d.account_id = w.account_id
       LEFT JOIN installation_endpoints e ON e.installation_id = w.installation_id
      WHERE w.account_id = ?`,
  ).bind(accountId).first<WorkspaceRow>();
}

function linked(row: WorkspaceRow, now: number) {
  return row.installation_revoked_at === null && row.device_revoked_at === null && row.device_expires_at > now;
}

function ready(row: WorkspaceRow, now: number) {
  return linked(row, now) && row.ready === 1 && row.endpoint_status === "ready"
    && row.hostname !== null && row.last_seen_at !== null && row.last_seen_at > now - HEARTBEAT_TTL_MS;
}

async function register(request: Request, env: Env): Promise<Response> {
  const device = await requireDevice(request, env);
  const input = await parse(request, createInstallationSchema);
  const pinned = await workspace(env, device.account_id);
  if (pinned && pinned.client_instance_id !== input.clientInstanceId) throw new HTTPError(409, "workspace_already_linked");
  if (pinned?.installation_revoked_at != null) throw new HTTPError(409, "workspace_revoked");

  let existing = await env.DB.prepare(
    "SELECT id FROM installations WHERE owner_user_id = ? AND client_instance_id = ? AND revoked_at IS NULL",
  ).bind(device.account_id, input.clientInstanceId).first<{ id: string }>();
  let created: { installation: { id: string }; credential: string; credentialExpiresAt: number } | null = null;
  if (!existing) {
    try {
      const registration = new Request(request.url, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      const response = await createInstallationForOwner(registration, env, device.account_id);
      created = await response.json();
      existing = { id: created!.installation.id };
    } catch (error) {
      if (!(error instanceof HTTPError) || error.code !== "installation_exists") throw error;
      existing = await env.DB.prepare(
        "SELECT id FROM installations WHERE owner_user_id = ? AND client_instance_id = ? AND revoked_at IS NULL",
      ).bind(device.account_id, input.clientInstanceId).first<{ id: string }>();
      if (!existing) throw error;
    }
  }

  await env.DB.prepare(
    `INSERT INTO account_workspaces (account_id, installation_id, device_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET device_id = excluded.device_id, ready = 0, last_seen_at = NULL
     WHERE account_workspaces.installation_id = excluded.installation_id`,
  ).bind(device.account_id, existing.id, device.id, Date.now()).run();
  const bound = await workspace(env, device.account_id);
  if (bound?.installation_id !== existing.id || bound.device_id !== device.id) throw new HTTPError(409, "workspace_already_linked");
  if (created) return json(created, 201);
  const installation = await ownedActiveInstallation(existing.id, device.account_id, env);
  if (!installation) throw new HTTPError(409, "workspace_revoked");
  const response = await rotateInstallationCredentialForOwner(existing.id, env, device.account_id);
  const credential = await response.json<{ credential: string; credentialExpiresAt: number }>();
  return json({ installation: installationJSON(installation), credential: credential.credential, credentialExpiresAt: credential.credentialExpiresAt }, 201);
}

async function heartbeat(request: Request, env: Env): Promise<Response> {
  const device = await requireDevice(request, env);
  const input = await parse(request, heartbeatSchema);
  const now = Date.now();
  const current = await workspace(env, device.account_id);
  if (!current || current.installation_id !== input.installationId || current.device_id !== device.id
    || !linked(current, now)) throw new HTTPError(409, "workspace_unlinked");
  const reachable = input.ready && current.endpoint_status === "ready" && current.hostname !== null;
  await env.DB.prepare(
    `UPDATE account_workspaces SET ready = ?, last_seen_at = ?
      WHERE account_id = ? AND installation_id = ? AND device_id = ?`,
  ).bind(reachable ? 1 : 0, now, device.account_id, input.installationId, device.id).run();
  await env.DB.prepare("UPDATE installations SET last_seen_at = ? WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL")
    .bind(now, input.installationId, device.account_id).run();
  await env.DB.prepare("DELETE FROM workspace_pairings WHERE account_id = ? AND expires_at <= ?")
    .bind(device.account_id, now).run();
  if (input.pairing) {
    if (!reachable || input.pairing.expiresAt <= now) throw new HTTPError(409, "pairing_expired");
    const pairing = input.pairing;
    const completed = await env.DB.prepare(
      `UPDATE workspace_pairings
          SET credential = ?, credential_expires_at = MIN(?, ?, expires_at)
        WHERE account_id = ? AND request_id = ? AND installation_id = ? AND expires_at > ?
          AND (credential IS NULL OR credential = ?)
          AND EXISTS (SELECT 1 FROM cloud_devices WHERE id = ? AND revoked_at IS NULL AND expires_at > ?)`,
    ).bind(pairing.credential, pairing.expiresAt, now + PAIRING_TTL_MS, device.account_id,
      pairing.requestId, input.installationId, now, pairing.credential, device.id, now).run();
    if (completed.meta.changes !== 1) throw new HTTPError(409, "pairing_expired");
  }
  const pending = reachable ? await env.DB.prepare(
    `SELECT request_id, label, expires_at FROM workspace_pairings
      WHERE account_id = ? AND installation_id = ? AND credential IS NULL AND expires_at > ?
      ORDER BY created_at, request_id LIMIT 1`,
  ).bind(device.account_id, input.installationId, now).first<PairingRow>() : null;
  return json({ bound: true, ...(pending ? { request: { id: pending.request_id, label: pending.label, expiresAt: pending.expires_at } } : {}) });
}

async function createPairing(env: Env, accountId: string, installationId: string, requestId: string, name: string, now: number) {
  const limited = await env.DB.prepare(
    `INSERT INTO control_action_rate_limits (user_id, action, window_started_at, attempts, updated_at)
     VALUES (?, 'workspace_pairing', ?, 1, ?)
     ON CONFLICT(user_id, action) DO UPDATE SET
       window_started_at = CASE WHEN window_started_at <= ? THEN excluded.window_started_at ELSE window_started_at END,
       attempts = CASE WHEN window_started_at <= ? THEN 1 ELSE attempts + 1 END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < 20`,
  ).bind(accountId, now, now, now - 60_000, now - 60_000, now - 60_000).run();
  if (limited.meta.changes !== 1) throw new HTTPError(429, "rate_limited");
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO workspace_pairings (account_id, request_id, installation_id, label, expires_at, created_at)
     SELECT ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM workspace_pairings WHERE account_id = ? AND expires_at > ?) < ?`,
  ).bind(accountId, requestId, installationId, name, now + PAIRING_TTL_MS, now, accountId, now, MAX_PENDING_PAIRINGS).run();
  if (inserted.meta.changes !== 1) {
    const existing = await env.DB.prepare("SELECT request_id FROM workspace_pairings WHERE account_id = ? AND request_id = ?")
      .bind(accountId, requestId).first();
    if (!existing) throw new HTTPError(429, "rate_limited");
  }
}

async function resolve(request: Request, env: Env, auth: ControlPlaneAuth): Promise<Response> {
  const session = await accountSession(request, auth);
  if (!session) throw new HTTPError(401, "unauthorized");
  const input = await parse(request, workspaceRequestSchema);
  const account = { id: session.user.id, email: session.user.email };
  const now = Date.now();
  await env.DB.prepare("DELETE FROM workspace_pairings WHERE account_id = ? AND (expires_at <= ? OR credential_expires_at <= ?)")
    .bind(account.id, now, now).run();
  const current = await workspace(env, account.id);
  if (!current) {
    const desktop = await env.DB.prepare("SELECT id FROM cloud_devices WHERE account_id = ? LIMIT 1").bind(account.id).first();
    return json({ account, workspace: desktop ? { state: "unlinked" } : null });
  }
  if (!linked(current, now)) return json({ account, workspace: { state: "unlinked" } });
  const origin = current.hostname ? `https://${current.hostname}` : undefined;
  if (!ready(current, now)) return json({ account, workspace: { state: "offline", ...(origin ? { origin } : {}) } });
  if (!input.requestId) return json({ account, workspace: { state: "ready", origin: origin! } });
  let pairing = await env.DB.prepare(
    "SELECT request_id, label, credential, credential_expires_at, expires_at FROM workspace_pairings WHERE account_id = ? AND request_id = ? AND installation_id = ?",
  ).bind(account.id, input.requestId, current.installation_id).first<PairingRow>();
  if (!pairing) {
    await createPairing(env, account.id, current.installation_id, input.requestId, input.label!, now);
    pairing = await env.DB.prepare(
      "SELECT request_id, label, credential, credential_expires_at, expires_at FROM workspace_pairings WHERE account_id = ? AND request_id = ? AND installation_id = ?",
    ).bind(account.id, input.requestId, current.installation_id).first<PairingRow>();
  }
  return json({
    account,
    workspace: {
      state: "ready",
      origin: origin!,
      ...(pairing?.credential && pairing.credential_expires_at && pairing.credential_expires_at > now ? {
        pairing: { credential: pairing.credential, expiresAt: pairing.credential_expires_at, requestId: pairing.request_id },
      } : {}),
    },
  });
}

export async function workspaceRoute(request: Request, env: Env, auth: ControlPlaneAuth): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const path = new URL(request.url).pathname;
  if (path === "/api/cloud/desktop/workspace/installation") return register(request, env);
  if (path === "/api/cloud/desktop/workspace") return heartbeat(request, env);
  if (path === "/api/cloud/workspace") return resolve(request, env, auth);
  return null;
}
