import { z } from "zod";

import { accountSession, type ControlPlaneAuth } from "./auth";
import type { ControlPlaneConfig } from "./config";
import { INVITE_HOLD_MS, joinWaitlist } from "./waitlist";
import { errorResponse, HTTPError, json, readBoundedJSON, type JSONValue } from "./http";
import { sha256 } from "./installations";

export const CLOUD_CONTRACT_VERSION = 1;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;
const DEVICE_TOKEN = /^omc_[A-Za-z0-9_-]{43}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/;
const ENROLL_SECONDS = 900;
const POLL_SECONDS = 5;
const DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const BETA_ENTITLEMENT_MS = 30 * 24 * 60 * 60 * 1000;
const AUTHORIZE_WINDOW_MS = 10 * 60 * 1000;
const AUTHORIZE_MAX_PER_SOURCE = 10;
const DEFAULT_HOME_CAP = 200;
const DESKTOP_PAIRING_LABEL = "later.dog for Mac";
const PHONE_PAIRING_LABEL = "later.dog for iPhone";

export type HomeState = "setting_up" | "ready" | "failed";
export interface HomeSummary {
  state: HomeState;
  origin: string;
  setup?: { step: "reserving" | "storage" | "starting" | "checking"; slow?: true };
}
export type PairOutcome =
  | { ok: true; origin: string; code: string; credential: string; expiresAt: number }
  | { ok: false; summary: HomeSummary | null; status?: number };

export interface HomesService {
  open(accountId: string): Promise<HomeSummary>;
  summary(accountId: string): Promise<HomeSummary | null>;
  pair(accountId: string, input: { label: string; ttlSeconds: number }): Promise<PairOutcome>;
  remove(accountId: string): Promise<{ removed: number }>;
}

const authorizeSchema = z.object({
  deviceName: z.string().min(1).max(100).regex(/^[^\p{Cc}]+$/u),
  platform: z.enum(["darwin", "win32", "linux"]),
  appVersion: z.string().min(1).max(40).regex(/^[^\p{Cc}]+$/u).optional(),
}).strict();
const tokenSchema = z.object({ deviceCode: z.string().regex(DEVICE_CODE) }).strict();
const approveSchema = z.object({ userCode: z.string().regex(USER_CODE), decision: z.enum(["allow", "deny"]) }).strict();

interface DeviceRow {
  id: string;
  account_id: string;
  expires_at: number;
  revoked_at: number | null;
  email: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomCode(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function newUserCode(): string {
  const picks = crypto.getRandomValues(new Uint8Array(10));
  const letters = Array.from(picks, (value) => USER_CODE_ALPHABET[value % USER_CODE_ALPHABET.length]).join("");
  return `${letters.slice(0, 5)}-${letters.slice(5)}`;
}

function cloudOrigin(config: ControlPlaneConfig): string {
  return new URL(config.authBaseURL).origin;
}

function homeCap(env: Env): number {
  const raw = Number((env as unknown as { CLOUD_HOME_CAP?: string }).CLOUD_HOME_CAP ?? DEFAULT_HOME_CAP);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : DEFAULT_HOME_CAP;
}

async function readJSON<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}

export async function homeAllowed(env: Env, accountId: string, now = Date.now()): Promise<boolean> {
  const existing = await env.DB.prepare("SELECT account_id FROM cloud_homes WHERE account_id = ?").bind(accountId).first();
  if (existing) return true;
  const result = await env.DB.prepare(
    `INSERT INTO cloud_homes (account_id, created_at)
     SELECT ?, ? WHERE (SELECT COUNT(*) FROM cloud_homes)
       + (SELECT COUNT(*) FROM cloud_waitlist w WHERE w.invited_at > ? AND w.account_id <> ?
          AND NOT EXISTS (SELECT 1 FROM cloud_homes h WHERE h.account_id = w.account_id)) < ?`,
  ).bind(accountId, now, now - INVITE_HOLD_MS, accountId, homeCap(env)).run();
  if (result.meta.changes === 1) return true;
  await joinWaitlist(env, accountId, now);
  return false;
}

export function cloudHomeCap(env: Env): number {
  return homeCap(env);
}

function cloudField(summary: HomeSummary | null): JSONValue {
  if (!summary) return null;
  return {
    state: summary.state,
    origin: summary.origin,
    pairingAvailable: summary.state === "ready",
    ...(summary.setup ? { setup: summary.setup.slow ? { step: summary.setup.step, slow: true } : { step: summary.setup.step } } : {}),
  };
}

function entitlement(allowed: boolean, now: number): JSONValue {
  if (!allowed) return { plan: "free", status: "inactive", expiresAt: null, version: 1 };
  return { plan: "pro", tier: "beta", status: "active", expiresAt: now + BETA_ENTITLEMENT_MS, version: 1 };
}

async function sourceHash(request: Request): Promise<string> {
  return sha256(`cloud-authorize:${request.headers.get("cf-connecting-ip") ?? "unknown"}`);
}

async function authorize(request: Request, env: Env, config: ControlPlaneConfig): Promise<Response> {
  const input = await readJSON(request, authorizeSchema);
  const now = Date.now();
  const source = await sourceHash(request);
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM cloud_device_authorizations WHERE source_hash = ? AND created_at > ?",
  ).bind(source, now - AUTHORIZE_WINDOW_MS).first<{ count: number }>();
  if ((recent?.count ?? 0) >= AUTHORIZE_MAX_PER_SOURCE) throw new HTTPError(429, "rate_limited");
  const deviceCode = randomCode(32);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const userCode = newUserCode();
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO cloud_device_authorizations
        (device_code_hash, user_code, device_name, platform, app_version, source_hash, status, interval_seconds, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).bind(await sha256(deviceCode), userCode, input.deviceName, input.platform, input.appVersion ?? null, source, POLL_SECONDS, now + ENROLL_SECONDS * 1000, now).run();
    if (inserted.meta.changes === 1) {
      return json({
        cloudContractVersion: CLOUD_CONTRACT_VERSION,
        deviceCode,
        userCode,
        verificationUriComplete: `${cloudOrigin(config)}/cloud/desktop?code=${userCode}`,
        expiresIn: ENROLL_SECONDS,
        interval: POLL_SECONDS,
      });
    }
  }
  throw new HTTPError(503, "busy");
}

async function token(request: Request, env: Env): Promise<Response> {
  const { deviceCode } = await readJSON(request, tokenSchema);
  const now = Date.now();
  const hash = await sha256(deviceCode);
  const row = await env.DB.prepare(
    `SELECT a.status, a.account_id, a.device_name, a.platform, a.app_version, a.interval_seconds, a.last_polled_at, a.expires_at, u.email
       FROM cloud_device_authorizations a LEFT JOIN "user" u ON u.id = a.account_id
      WHERE a.device_code_hash = ?`,
  ).bind(hash).first<{ status: string; account_id: string | null; device_name: string; platform: string; app_version: string | null; interval_seconds: number; last_polled_at: number | null; expires_at: number; email: string | null }>();
  if (!row || row.status === "redeemed") return errorResponse(400, "invalid_grant");
  if (row.expires_at <= now) return errorResponse(400, "expired_token");
  if (row.status === "denied") return errorResponse(400, "access_denied");
  if (row.status === "pending") {
    const early = row.last_polled_at !== null && now - row.last_polled_at < row.interval_seconds * 1000;
    await env.DB.prepare("UPDATE cloud_device_authorizations SET last_polled_at = ? WHERE device_code_hash = ?").bind(now, hash).run();
    if (early) return json({ error: "slow_down", interval: row.interval_seconds + 5 }, 400);
    return errorResponse(400, "authorization_pending");
  }
  if (!row.account_id || !row.email) return errorResponse(400, "invalid_grant");
  const claimed = await env.DB.prepare(
    "UPDATE cloud_device_authorizations SET status = 'redeemed' WHERE device_code_hash = ? AND status = 'approved'",
  ).bind(hash).run();
  if (claimed.meta.changes !== 1) return errorResponse(400, "invalid_grant");
  const accessToken = `omc_${randomCode(32)}`;
  const deviceId = crypto.randomUUID();
  const expiresAt = now + DEVICE_TOKEN_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO cloud_devices (id, account_id, token_hash, device_name, platform, app_version, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(deviceId, row.account_id, await sha256(accessToken), row.device_name, row.platform, row.app_version, now, expiresAt).run();
  return json({
    cloudContractVersion: CLOUD_CONTRACT_VERSION,
    accessToken,
    expiresAt,
    device: { id: deviceId },
    account: { id: row.account_id, email: row.email },
  });
}

export async function requireDevice(request: Request, env: Env): Promise<DeviceRow> {
  const presented = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  if (!DEVICE_TOKEN.test(presented)) throw new HTTPError(401, "invalid_token");
  const row = await env.DB.prepare(
    `SELECT d.id, d.account_id, d.expires_at, d.revoked_at, u.email
       FROM cloud_devices d JOIN "user" u ON u.id = d.account_id
      WHERE d.token_hash = ?`,
  ).bind(await sha256(presented)).first<DeviceRow>();
  if (!row || row.revoked_at !== null || row.expires_at <= Date.now()) throw new HTTPError(401, "invalid_token");
  return row;
}

async function desktopSession(request: Request, env: Env, homes: HomesService): Promise<Response> {
  const device = await requireDevice(request, env);
  const now = Date.now();
  await env.DB.prepare("UPDATE cloud_devices SET last_seen_at = ? WHERE id = ?").bind(now, device.id).run();
  const allowed = await homeAllowed(env, device.account_id, now);
  const summary = allowed ? await homes.open(device.account_id) : null;
  return json({
    cloudContractVersion: CLOUD_CONTRACT_VERSION,
    expiresAt: device.expires_at,
    device: { id: device.id },
    account: { id: device.account_id, email: device.email },
    entitlement: entitlement(allowed, now),
    cloud: cloudField(summary),
  });
}

async function revokeDevice(request: Request, env: Env): Promise<Response> {
  const device = await requireDevice(request, env);
  await env.DB.prepare("UPDATE cloud_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(Date.now(), device.id).run();
  return json({ revoked: true });
}

async function pairingResponse(homes: HomesService, accountId: string, label: string, ttlSeconds: number): Promise<Response> {
  const outcome = await homes.pair(accountId, { label, ttlSeconds });
  if (!outcome.ok) return json({ error: "not_ready", cloud: cloudField(outcome.summary) }, 409);
  return json({ cloudContractVersion: CLOUD_CONTRACT_VERSION, origin: outcome.origin, code: outcome.code, expiresAt: outcome.expiresAt });
}

async function desktopPairing(request: Request, env: Env, homes: HomesService): Promise<Response> {
  const device = await requireDevice(request, env);
  if (!(await homeAllowed(env, device.account_id))) return errorResponse(403, "no_home");
  return pairingResponse(homes, device.account_id, DESKTOP_PAIRING_LABEL, 300);
}

async function requireAccount(request: Request, auth: ControlPlaneAuth) {
  const session = await accountSession(request, auth);
  if (!session) throw new HTTPError(401, "unauthorized");
  return session;
}

async function authorizationDetails(url: URL, env: Env): Promise<Response> {
  const userCode = url.searchParams.get("code") ?? "";
  if (!USER_CODE.test(userCode)) return errorResponse(400, "invalid_request");
  const row = await env.DB.prepare(
    "SELECT device_name, platform, status, expires_at FROM cloud_device_authorizations WHERE user_code = ?",
  ).bind(userCode).first<{ device_name: string; platform: string; status: string; expires_at: number }>();
  if (!row || row.status !== "pending" || row.expires_at <= Date.now()) return errorResponse(404, "not_found");
  return json({ deviceName: row.device_name, platform: row.platform, expiresAt: row.expires_at });
}

async function approve(request: Request, env: Env, auth: ControlPlaneAuth): Promise<Response> {
  const session = await requireAccount(request, auth);
  const { userCode, decision } = await readJSON(request, approveSchema);
  const updated = await env.DB.prepare(
    `UPDATE cloud_device_authorizations SET status = ?, account_id = ?
      WHERE user_code = ? AND status = 'pending' AND expires_at > ?`,
  ).bind(decision === "allow" ? "approved" : "denied", session.user.id, userCode, Date.now()).run();
  if (updated.meta.changes !== 1) return errorResponse(404, "not_found");
  return json({ approved: decision === "allow" });
}

async function accountHome(request: Request, env: Env, auth: ControlPlaneAuth, homes: HomesService): Promise<Response> {
  const session = await requireAccount(request, auth);
  const allowed = await homeAllowed(env, session.user.id);
  const summary = allowed ? await homes.open(session.user.id) : null;
  return json({
    cloudContractVersion: CLOUD_CONTRACT_VERSION,
    account: { id: session.user.id, email: session.user.email },
    entitlement: entitlement(allowed, Date.now()),
    cloud: cloudField(summary),
  });
}

async function phonePairing(request: Request, env: Env, auth: ControlPlaneAuth, homes: HomesService): Promise<Response> {
  const session = await requireAccount(request, auth);
  if (!(await homeAllowed(env, session.user.id))) return errorResponse(403, "no_home");
  return pairingResponse(homes, session.user.id, PHONE_PAIRING_LABEL, 120);
}

async function deleteAccount(request: Request, env: Env, auth: ControlPlaneAuth, homes: HomesService): Promise<Response> {
  const session = await requireAccount(request, auth);
  const hadHome = await env.DB.prepare("SELECT account_id FROM cloud_homes WHERE account_id = ?").bind(session.user.id).first();
  if (hadHome) await homes.remove(session.user.id);
  await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(session.user.id).run();
  return json({ deleted: true });
}

export async function cloudRoute(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
  config: ControlPlaneConfig,
  homes: HomesService,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (!path.startsWith("/api/cloud/")) return null;
  if (method === "POST" && path === "/api/cloud/desktop/authorize") return authorize(request, env, config);
  if (method === "POST" && path === "/api/cloud/desktop/token") return token(request, env);
  if (method === "GET" && path === "/api/cloud/desktop/session") return desktopSession(request, env, homes);
  if (method === "DELETE" && path === "/api/cloud/desktop/session") return revokeDevice(request, env);
  if (method === "POST" && path === "/api/cloud/desktop/pairing") return desktopPairing(request, env, homes);
  if (method === "POST" && path === "/api/cloud/desktop/disk") return errorResponse(404, "not_supported");
  if (method === "GET" && path === "/api/cloud/desktop/authorization") return authorizationDetails(url, env);
  if (method === "POST" && path === "/api/cloud/desktop/approve") return approve(request, env, auth);
  if (method === "POST" && path === "/api/cloud/home") return accountHome(request, env, auth, homes);
  if (method === "POST" && path === "/api/cloud/pairing") return phonePairing(request, env, auth, homes);
  if (method === "DELETE" && path === "/api/cloud/account") return deleteAccount(request, env, auth, homes);
  return errorResponse(404, "not_found");
}
