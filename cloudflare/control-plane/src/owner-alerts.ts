import { z } from "zod";

import { readConfig, type ControlPlaneConfig } from "./config";

export const OWNER_ALERT_KINDS = ["code_email_failed", "sign_ups_capped", "homes_full", "home_start_failed", "server_error"] as const;
export type OwnerAlertKind = (typeof OWNER_ALERT_KINDS)[number];
export const OWNER_ALERT_EVERY_SECONDS = 60 * 60;

const OWNER_ALERT_CACHE = "owner-alerts";
const OWNER_ALERT_CACHE_PATH = "/__internal/owner-alert/v1/";
const OWNER_ALERT_FOOTER = "You get at most one of these an hour for each kind of problem. Details: Cloudflare dashboard > Workers > laterdog-control-plane > Logs.";
const LOGIN_PATHS = ["/api/auth/", "/api/cloud/"];
const ALERTED_ELSEWHERE = new Set(["email_unavailable"]);
const EMAIL_SERVICE_CODE = /^E_[A-Z_]{1,60}$/;
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;
const alertAddressSchema = z.email().max(254);

export interface OwnerAlert {
  kind: OwnerAlertKind;
  subject: string;
  text: string;
}

export interface OwnerAlertSender {
  send(message: { to: string; from: { email: string; name: string }; subject: string; text: string }): Promise<unknown>;
}

function at(now: number): string {
  return `${new Date(now).toISOString().slice(11, 16)} UTC`;
}

export const ownerAlerts = {
  codeEmailFailed: (code: string, now = Date.now()): OwnerAlert => ({
    kind: "code_email_failed",
    subject: "later.dog: sign-in codes aren't sending",
    text: `A sign-in code email failed to send at ${at(now)} (${code}). Until codes send, people can't sign in.`,
  }),
  signUpsCapped: (now = Date.now()): OwnerAlert => ({
    kind: "sign_ups_capped",
    subject: "later.dog: today's new sign-ups are used up",
    text: `At ${at(now)} a new address was refused a sign-in code because today's cap for new addresses is used up. New people can sign up again after 00:00 UTC, or sooner if you raise NEW_EMAIL_CODES_PER_DAY and deploy.`,
  }),
  homesFull: (cap: number, now = Date.now()): OwnerAlert => ({
    kind: "homes_full",
    subject: "later.dog: Cloud homes are full",
    text: `At ${at(now)} someone signed in and went on the waitlist because all ${cap} Cloud homes are taken. Raise CLOUD_HOME_CAP and deploy to let more in.`,
  }),
  homeStartFailed: (now = Date.now()): OwnerAlert => ({
    kind: "home_start_failed",
    subject: "later.dog: a Cloud home didn't start",
    text: `At ${at(now)} a Cloud home failed to start for someone who had just signed in.`,
  }),
  serverError: (route: string, status: number, now = Date.now()): OwnerAlert => ({
    kind: "server_error",
    subject: "later.dog: sign-in answered with an error",
    text: `At ${at(now)} the sign-in service answered ${status} to ${route}.`,
  }),
};

export function emailServiceCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && EMAIL_SERVICE_CODE.test(code) ? code : "no error code";
}

export function routeLabel(request: Request): string {
  const path = new URL(request.url).pathname
    .split("/")
    .map((segment) => (OPAQUE_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
  return `${request.method} ${path}`;
}

export function serverErrorAlert(request: Request, response: Response): Promise<OwnerAlert | null> {
  const path = new URL(request.url).pathname;
  if (response.status < 500 || !LOGIN_PATHS.some((prefix) => path.startsWith(prefix))) return Promise.resolve(null);
  const route = routeLabel(request);
  const { status } = response;
  return response.clone().json<{ error?: unknown }>().catch(() => null).then((body) => {
    if (typeof body?.error === "string" && ALERTED_ELSEWHERE.has(body.error)) return null;
    return ownerAlerts.serverError(route, status);
  });
}

export function ownerAlertAddress(env: Env): string | null {
  const value = (env as unknown as { ALERT_EMAIL?: unknown }).ALERT_EMAIL;
  if (typeof value !== "string") return null;
  const parsed = alertAddressSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : null;
}

function alertCacheKey(config: ControlPlaneConfig, kind: OwnerAlertKind): string {
  return new URL(`${OWNER_ALERT_CACHE_PATH}${kind}`, config.authBaseURL).toString();
}

async function firstThisHour(config: ControlPlaneConfig, kind: OwnerAlertKind): Promise<boolean> {
  const cache = await caches.open(OWNER_ALERT_CACHE).catch(() => null);
  if (!cache) return true;
  const key = alertCacheKey(config, kind);
  if (await cache.match(key).catch(() => undefined)) return false;
  await cache.put(key, new Response("sent", { headers: { "cache-control": `max-age=${OWNER_ALERT_EVERY_SECONDS}` } })).catch(() => undefined);
  return true;
}

export async function forgetOwnerAlerts(config: ControlPlaneConfig): Promise<void> {
  const cache = await caches.open(OWNER_ALERT_CACHE).catch(() => null);
  await Promise.all(OWNER_ALERT_KINDS.map((kind) => cache?.delete(alertCacheKey(config, kind)).catch(() => false)));
}

export async function alertOwner(
  env: Env,
  alert: OwnerAlert,
  sender: OwnerAlertSender = env.EMAIL as unknown as OwnerAlertSender,
): Promise<boolean> {
  const to = ownerAlertAddress(env);
  if (!to) return false;
  let config: ControlPlaneConfig;
  try {
    config = readConfig(env);
  } catch {
    return false;
  }
  if (!(await firstThisHour(config, alert.kind))) return false;
  try {
    await sender.send({
      to,
      from: { email: config.emailFrom, name: "later.dog" },
      subject: alert.subject,
      text: `${alert.text}\n\n${OWNER_ALERT_FOOTER}`,
    });
    return true;
  } catch {
    console.error(JSON.stringify({ message: "owner alert failed", kind: alert.kind }));
    return false;
  }
}

export async function alertOwnerOnServerError(env: Env, alert: Promise<OwnerAlert | null>): Promise<void> {
  const ready = await alert;
  if (ready) await alertOwner(env, ready);
}
