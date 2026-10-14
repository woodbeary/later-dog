import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { Scope, SessionRecord, SessionRegistry } from "./sessions.ts";
import { denyReason as companionDenial, isCompanionNotice } from "../companion/src/routes.ts";

export type LoopbackTrust = "owner" | "service";

export type RequestAuth =
  | { kind: "loopback"; scopes: readonly Scope[]; trust?: "service" }
  | { kind: "session"; session: SessionRecord; via: "bearer" | "cookie" | "ticket"; scopes: readonly Scope[] };

export interface RequestAuthResult {
  auth: RequestAuth | null;
  status: 401 | 403;
  error: string;
}

const LOOPBACK_SCOPES: readonly Scope[] = ["admin", "client"];
const SERVICE_SCOPES: readonly Scope[] = ["client"];

export const SERVICE_ALLOW: ReadonlyArray<{ methods: readonly string[]; path: RegExp }> = [
  { methods: ["GET"], path: /^\/api\/health$/ },
  { methods: ["GET"], path: /^\/api\/auth\/session$/ },
  { methods: ["GET"], path: /^\/api\/edition$/ },
  { methods: ["GET"], path: /^\/api\/brand$/ },
  { methods: ["GET"], path: /^\/api\/bots$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { methods: ["GET"], path: /^\/api\/attachments\/[\w.-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages\/guarded$/ },
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/requests\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/requests\/[\w-]+\/interrupt$/ },
  { methods: ["DELETE"], path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], path: /^\/api\/internal\// },
  { methods: ["POST"], path: /^\/api\/testing\/internal-capability$/ },
];

export function serviceAllowed(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return SERVICE_ALLOW.some((rule) => rule.methods.includes(upper) && rule.path.test(path));
}

export function resolveLoopbackTrust(input: {
  env?: NodeJS.ProcessEnv;
  desktopManaged: boolean;
  hostedWorkspace: boolean;
  cloudHome?: boolean;
}): { trust: LoopbackTrust; reason: string; warning?: string } {
  const raw = (input.env ?? process.env).LATERDOG_LOOPBACK_TRUST;
  const requested = raw?.trim().toLowerCase();
  if (input.cloudHome) {
    return { trust: "service", reason: "later.dog Cloud home", ...(raw !== undefined && requested !== "service" ? { warning: "LATERDOG_LOOPBACK_TRUST is ignored on a later.dog Cloud home: a local request is always a service" } : {}) };
  }
  if (input.desktopManaged) {
    return { trust: "owner", reason: "desktop app", ...(raw !== undefined ? { warning: "LATERDOG_LOOPBACK_TRUST is ignored in the desktop app" } : {}) };
  }
  if (requested === "owner" || requested === "service") {
    return {
      trust: requested,
      reason: "LATERDOG_LOOPBACK_TRUST",
      ...(requested === "owner" && input.hostedWorkspace
        ? { warning: "LATERDOG_LOOPBACK_TRUST=owner on a shared workspace: every bot's shell can change settings and approve cards as the owner" }
        : {}),
    };
  }
  if (raw !== undefined && requested !== "") {
    return { trust: "service", reason: "LATERDOG_LOOPBACK_TRUST", warning: `LATERDOG_LOOPBACK_TRUST="${raw.replace(/[^\w.-]/g, "").slice(0, 40)}" is not owner or service; using service` };
  }
  if (input.hostedWorkspace) return { trust: "service", reason: "hosted workspace" };
  return { trust: "owner", reason: "self-hosted default" };
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  if (!value) return false;

  let hostname = value;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0 || (value.length > close + 1 && !/^:\d+$/.test(value.slice(close + 1)))) return false;
    hostname = value.slice(1, close);
  } else {
    const firstColon = value.indexOf(":");
    const lastColon = value.lastIndexOf(":");
    if (firstColon >= 0 && firstColon === lastColon) {
      if (!/^\d+$/.test(value.slice(firstColon + 1))) return false;
      hostname = value.slice(0, firstColon);
    }
  }

  if (hostname === "localhost" || hostname === "localhost.") return true;
  if (isIP(hostname) === 4) return hostname.startsWith("127.");
  return hostname === "::1" || hostname === "0:0:0:0:0:0:0:1";
}

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return isLoopbackHost(o.hostname) && (o.protocol === "http:" || o.protocol === "https:");
  } catch {
    return false;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function requestOrigin(req: IncomingMessage): string | null {
  const host = headerValue(req.headers.host)?.trim();
  if (!host) return null;
  const forwarded = headerValue(req.headers["x-forwarded-proto"])?.split(",")[0]?.trim().toLowerCase();
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : "http";
  return `${proto}://${host.toLowerCase()}`;
}

export function isProxied(req: IncomingMessage): boolean {
  const h = req.headers;
  return ipcPeer(req) || Boolean(h["x-forwarded-for"] || h["x-forwarded-proto"] || h["x-forwarded-host"] || h["forwarded"]);
}

export function ipcPeer(req: IncomingMessage): boolean {
  const socket = req.socket;
  return Boolean(socket) && socket.remoteAddress === undefined && socket.remoteFamily === undefined;
}

export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  if (!origin) return true;
  const own = requestOrigin(req);
  return own !== null && origin.trim().toLowerCase() === own;
}

export function provesSameOrigin(req: IncomingMessage): boolean {
  if (headerValue(req.headers.origin)) return isSameOrigin(req);
  return headerValue(req.headers["sec-fetch-site"])?.trim().toLowerCase() === "same-origin";
}

export function requestSource(req: IncomingMessage): string {
  const peer = req.socket?.remoteAddress || "unknown";
  const viaLocalProxy = ipcPeer(req) || peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const hops = viaLocalProxy ? (headerValue(req.headers["x-forwarded-for"]) ?? "").split(",").map((h) => h.trim()).filter(Boolean) : [];
  const forwarded = hops.length ? hops[hops.length - 1] : undefined;
  return sanitizeSource(forwarded || peer);
}

export function sanitizeSource(value: string): string {
  const clean = value.replace(/[^\w.:%[\]-]/g, "");
  return (clean || "unknown").slice(0, 64);
}

export function labelFromUserAgent(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (!ua) return "Unnamed device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl\//.test(ua) ? "curl" : "Client";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = headerValue(header);
  if (!value) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return m?.[1];
}

export function sessionCookieName(port: number, environmentId: string): string {
  return `laterdog_session_${port}_${environmentId.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;
}

export function serializeSessionCookie(
  name: string,
  token: string,
  options: { secure: boolean; maxAgeSeconds: number },
): string {
  const parts = [`${name}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${options.maxAgeSeconds}`];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export const CLIENT_ALLOW: ReadonlyArray<{ methods: readonly string[]; path: RegExp; feature?: "sharedComputers" }> = [
  { methods: ["GET"], path: /^\/api\/auth\/session$/ },
  { methods: ["POST"], path: /^\/api\/auth\/stream-ticket$/ },
  { methods: ["POST"], path: /^\/api\/auth\/logout$/ },
  { methods: ["POST"], path: /^\/api\/shared-computers\/(?:connect|[\w-]+\/(?:poll|lease|result|disconnect))$/, feature: "sharedComputers" },
  { methods: ["GET"], path: /^\/api\/shared-computers$/, feature: "sharedComputers" },
  { methods: ["GET"], path: /^\/api\/health$/ },
  { methods: ["GET"], path: /^\/api\/edition$/ },
  { methods: ["GET"], path: /^\/api\/brand$/ },
  { methods: ["GET"], path: /^\/api\/events$/ },
  { methods: ["GET"], path: /^\/api\/helpers$/ },
  { methods: ["GET"], path: /^\/api\/bots$/ },
  { methods: ["GET"], path: /^\/api\/team-map$/ },
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/slack-management$/ },
  { methods: ["GET"], path: /^\/api\/search$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/export$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/file$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/compact$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { methods: ["POST"], path: /^\/api\/handoffs\/[\w-]+\/continue$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/read$/ },
  { methods: ["DELETE"], path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { methods: ["POST", "PATCH", "DELETE"], path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+\/title$/ },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+\/profile$/ },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/respond$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/undo$/ },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+\/cards\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/(?:resume|dismiss)$/ },
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/status$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/(?:resume|dismiss)$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/always-allow$/ },
  { methods: ["POST"], path: /^\/api\/groups$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/interrupt$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/read$/ },
  { methods: ["DELETE"], path: /^\/api\/groups\/[\w-]+\/queue\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/tasks$/ },
  { methods: ["POST", "PATCH", "DELETE"], path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { methods: ["PATCH"], path: /^\/api\/groups\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  { methods: ["POST"], path: /^\/api\/attachments$/ },
  { methods: ["GET"], path: /^\/api\/attachments\/[\w.-]+$/ },
  { methods: ["POST"], path: /^\/api\/files$/ },
  { methods: ["GET"], path: /^\/api\/tts\/voices$/ },
  { methods: ["POST"], path: /^\/api\/tts\/prepare$/ },
  { methods: ["POST"], path: /^\/api\/tts\/speak$/ },
  { methods: ["POST"], path: /^\/api\/voice\/transcribe$/ },
  { methods: ["POST"], path: /^\/api\/typing\/(?:complete|rank)$/ },
  { methods: ["GET"], path: /^\/api\/routines$/ },
  { methods: ["POST"], path: /^\/api\/routines$/ },
  { methods: ["PATCH", "DELETE"], path: /^\/api\/routines\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/routines\/[\w-]+\/run$/ },
  { methods: ["POST"], path: /^\/api\/routine-runs\/[\w-]+\/(?:cancel|seen)$/ },
  { methods: ["POST"], path: /^\/api\/routine-runs\/seen-all$/ },
  { methods: ["GET"], path: /^\/api\/webhooks$/ },
  { methods: ["GET"], path: /^\/api\/config$/ },
];

export function requiredScope(method: string, path: string, features: { sharedComputers?: boolean } = {}): Scope {
  const upper = method.toUpperCase();
  for (const rule of CLIENT_ALLOW) {
    if (rule.feature && features[rule.feature] !== true) continue;
    if (rule.path.test(path) && rule.methods.includes(upper)) return "client";
  }
  return "admin";
}

const CLIENT_BOT_PATCH_FIELDS = new Set(["unread", "pinned", "pinnedMessageId", "color", "mascotExpression", "mascotBody"]);
export function clientBotPatchViolation(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body";
  for (const key of Object.keys(body)) if (!CLIENT_BOT_PATCH_FIELDS.has(key)) return key;
  return null;
}

const CLIENT_GROUP_PATCH_FIELDS = new Set(["name", "bulletin", "unread", "pinnedMessageId", "section", "turnTimeoutMinutes"]);
export function clientGroupPatchViolation(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body";
  for (const key of Object.keys(body)) if (!CLIENT_GROUP_PATCH_FIELDS.has(key)) return key;
  return null;
}

export interface ResolveOptions {
  sessions: SessionRegistry;
  cookieName: string;
  streamPath: string;
  url: URL;
  loopbackMutationToken?: string;
  companionMutationToken?: string;
  features?: { sharedComputers?: boolean };
  loopbackTrust?: LoopbackTrust;
  cliOwnerToken?: string;
}

const CLI_OWNER_HEADER = "x-laterdog-cli-owner";
const CLI_OWNER_ROUTE = /^\/api\/auth\/pairing$/;

const DESKTOP_OWNER_HEADER = "x-laterdog-desktop-owner";

function mutatingPublicRoute(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  if (
    upper === "GET" &&
    /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/status$/.test(path)
  ) return true;
  if (path.startsWith("/api/desktop-viewer/")) return true;
  if (["GET", "HEAD", "OPTIONS"].includes(upper)) return false;
  return !path.startsWith("/api/internal/") &&
    path !== "/api/testing/internal-capability" &&
    path !== "/api/auth/pair" &&
    path !== "/api/pair";
}

function secureTokenMatch(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function resolveRequestAuth(req: IncomingMessage, options: ResolveOptions): RequestAuthResult {
  const method = req.method ?? "GET";
  const path = options.url.pathname;
  const deny = (status: 401 | 403, error: string): RequestAuthResult => ({ auth: null, status, error });

  const bearer = bearerToken(req.headers.authorization);
  const cookie = parseCookies(headerValue(req.headers.cookie)).get(options.cookieName);
  const ticket = path === options.streamPath ? options.url.searchParams.get("ticket") : null;
  let session: SessionRecord | null = null;
  let via: "bearer" | "cookie" | "ticket" | null = null;
  if (bearer?.startsWith("laterdog_sess_")) {
    session = options.sessions.authenticate(bearer);
    via = "bearer";
  } else if (ticket) {
    session = options.sessions.redeemStreamTicket(ticket);
    via = "ticket";
  } else if (cookie) {
    session = options.sessions.authenticate(cookie);
    via = "cookie";
  }

  if (session && via) {
    if (via === "cookie" && !isSameOrigin(req)) return deny(403, "forbidden: cross-origin request");
    if (via === "bearer" && session.cookieOnly) return deny(401, "unauthorized: this session belongs to a browser; sign in with a pairing code");
    if (via === "cookie" && session.cookieOnly && !["GET", "HEAD", "OPTIONS"].includes(method) && !provesSameOrigin(req)) {
      return deny(403, "forbidden: this browser's session makes changes only from its own page");
    }
    const needed = requiredScope(method, path, options.features ?? {});
    if (!session.scopes.includes(needed)) {
      return deny(403, `forbidden: this session lacks the ${needed} scope`);
    }
    if (via !== "ticket") options.sessions.renew(session.id);
    return { auth: { kind: "session", session, via, scopes: session.scopes }, status: 401, error: "" };
  }

  if (via) {
    return deny(401, "unauthorized: this session has expired or was revoked; pair this device again");
  }

  const proxied = isProxied(req);
  const loopback = !proxied && isLoopbackHost(headerValue(req.headers.host)) && isAllowedOrigin(headerValue(req.headers.origin));
  if (loopback) {
    const companionToken = headerValue(req.headers["x-laterdog-companion-auth"]);
    if (companionToken && options.loopbackMutationToken !== undefined) {
      if (
        !secureTokenMatch(companionToken, options.companionMutationToken ?? "") ||
        req.headers["x-laterdog-companion"] !== "1" ||
        !/^[\w-]{1,128}$/.test(headerValue(req.headers["x-laterdog-companion-device"]) ?? "") ||
        (companionDenial({ path, method, authenticated: true }) && !isCompanionNotice(method, path))
      ) return deny(403, "forbidden: invalid companion request");
      return { auth: { kind: "loopback", scopes: LOOPBACK_SCOPES }, status: 401, error: "" };
    }
    if (
      options.loopbackMutationToken !== undefined &&
      mutatingPublicRoute(method, path) &&
      !secureTokenMatch(headerValue(req.headers[DESKTOP_OWNER_HEADER]), options.loopbackMutationToken)
    ) {
      return deny(403, "forbidden: this change must come from the desktop app or a paired device");
    }
    if (options.loopbackMutationToken === undefined && options.loopbackTrust === "service") {
      if (
        options.cliOwnerToken && CLI_OWNER_ROUTE.test(path) && ["GET", "POST"].includes(method.toUpperCase()) &&
        secureTokenMatch(headerValue(req.headers[CLI_OWNER_HEADER]), options.cliOwnerToken)
      ) {
        return { auth: { kind: "loopback", scopes: LOOPBACK_SCOPES }, status: 401, error: "" };
      }
      if (!serviceAllowed(method, path)) {
        return deny(403, "forbidden: on this shared server a local request without a session may only use the service routes; sign in to change settings, people or access");
      }
      return { auth: { kind: "loopback", scopes: SERVICE_SCOPES, trust: "service" }, status: 401, error: "" };
    }
    return { auth: { kind: "loopback", scopes: LOOPBACK_SCOPES }, status: 401, error: "" };
  }

  if (proxied) {
    return deny(403, "forbidden: this request came through a proxy (pair this device to use the server remotely)");
  }
  if (!isLoopbackHost(headerValue(req.headers.host))) {
    return deny(403, "forbidden: loopback host required (pair this device to use the server remotely)");
  }
  return deny(403, "forbidden: cross-origin request");
}
