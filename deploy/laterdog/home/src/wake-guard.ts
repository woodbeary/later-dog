import { hex, sha256 } from "./encoding.ts";

export type WakeGuard = "learning" | "owners";
export type Wakers = Record<string, number>;

export type WakeCredential =
  | { kind: "session"; token: string; via: "bearer" }
  | { kind: "session"; token: string; via: "cookie"; cookie: string }
  | { kind: "hook"; endpoint: string; secret: string };

export type SessionCredential = Extract<WakeCredential, { kind: "session" }>;

export const SESSION_CHECK_PATH = "/api/auth/session";
export const WAKERS_KEPT = 64;
export const WAKER_FORGET_MS = 30 * 24 * 60 * 60_000;
export const WAKER_TOUCH_MS = 24 * 60 * 60_000;

const SESSION_TOKEN = /^laterdog_sess_[A-Za-z0-9_-]{32,128}$/;
const SESSION_COOKIE = /^laterdog_session_\d{1,5}_[A-Za-z0-9]{0,12}$/;
const HOOK_PATH = /^\/hooks\/(wh_[A-Za-z0-9_-]{1,128})(?:\/([^/]{1,512}))?$/;

export function wakeGuard(value: string | undefined): WakeGuard {
  return value?.trim().toLowerCase() === "owners" ? "owners" : "learning";
}

function bearer(request: Request): string | null {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization")?.trim() ?? "")?.[1] ?? null;
}

function hookCredential(request: Request, endpoint: string, inPath: string | undefined): WakeCredential | null {
  if (request.method !== "POST") return null;
  let secret: string;
  try {
    secret = inPath ? decodeURIComponent(inPath) : "";
  } catch {
    return null;
  }
  secret ||= bearer(request) ?? "";
  return secret ? { kind: "hook", endpoint, secret } : null;
}

function sessionCookie(request: Request): SessionCredential | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const cookie = part.slice(0, eq).trim();
    const token = part.slice(eq + 1).trim();
    if (SESSION_COOKIE.test(cookie) && SESSION_TOKEN.test(token)) return { kind: "session", token, via: "cookie", cookie };
  }
  return null;
}

export function wakeCredential(request: Request): WakeCredential | null {
  const hook = HOOK_PATH.exec(new URL(request.url).pathname);
  if (hook) return hookCredential(request, hook[1], hook[2]);
  const token = bearer(request);
  if (token !== null && SESSION_TOKEN.test(token)) return { kind: "session", token, via: "bearer" };
  return sessionCookie(request);
}

export async function wakerKey(credential: WakeCredential): Promise<string> {
  const material = credential.kind === "hook" ? `hook\n${credential.endpoint}\n${credential.secret}` : `session\n${credential.token}`;
  return hex(await sha256(`laterdog-home:waker:${material}`));
}

export function sessionCheck(origin: string, credential: SessionCredential): Request {
  const headers = new Headers({ accept: "application/json" });
  if (credential.via === "bearer") headers.set("authorization", `Bearer ${credential.token}`);
  else headers.set("cookie", `${credential.cookie}=${credential.token}`);
  return new Request(`${origin}${SESSION_CHECK_PATH}`, { headers });
}

export type CheckOutcome = "owner" | "refused" | "unknown";

export async function sessionCheckOutcome(response: Response): Promise<CheckOutcome> {
  if (response.status === 401 || response.status === 403) return "refused";
  if (!response.ok) return "unknown";
  const body = (await response.json().catch(() => null)) as { kind?: unknown } | null;
  return body?.kind === "session" ? "owner" : "refused";
}

export function hookAccepted(response: Response): boolean {
  return response.status === 202;
}

export function remembered(wakers: Wakers, key: string, now: number): boolean {
  const seen = wakers[key];
  return seen !== undefined && now - seen < WAKER_FORGET_MS;
}

export function seenLongAgo(wakers: Wakers, key: string, now: number): boolean {
  return now - (wakers[key] ?? 0) >= WAKER_TOUCH_MS;
}

export function remember(wakers: Wakers, key: string, now: number): Wakers {
  const kept = Object.entries(wakers)
    .filter(([known, seen]) => known !== key && now - seen < WAKER_FORGET_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, WAKERS_KEPT - 1);
  return Object.fromEntries([[key, now], ...kept]);
}
