import { z } from "zod";

import { isDisposableEmail } from "./disposable-email";
import { errorResponse, json } from "./http";
import { isReviewEmail, reviewSignIn } from "./review-signin";
import { carriesCaptcha, turnstileSecret } from "./turnstile";

const OTP_SEND_PATH = "/api/auth/email-otp/send-verification-otp";
const RECIPIENT_WINDOW_MS = 15 * 60 * 1_000;
const RECIPIENT_MAX_ATTEMPTS = 3;
const REVIEW_MAX_ATTEMPTS = 20;
const RETENTION_MS = 24 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_NEW_EMAIL_CODES_PER_DAY = 200;
export const DEFAULT_UNVERIFIED_NEW_EMAIL_CODES_PER_DAY = 100;
const MAX_CODES_PER_DAY = 1_000_000;
const MAX_EMAIL_LENGTH = 254;
const codeRequestSchema = z.object({
  email: z.string(),
  type: z.unknown().optional(),
});
const emailSchema = z.email().max(MAX_EMAIL_LENGTH);

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function recipientKey(email: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email)));
}

interface CodeRequest {
  email: string;
  signsIn: boolean;
}

async function codeRequest(request: Request): Promise<CodeRequest | null> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }
  const parsed = codeRequestSchema.safeParse(body);
  if (!parsed.success) return null;
  const email = parsed.data.email.toLowerCase();
  if (!emailSchema.safeParse(email).success) return null;
  return { email, signsIn: parsed.data.type === "sign-in" };
}

function secondsToNextUTCDay(now: number): number {
  return Math.max(1, Math.ceil(((utcDay(now) + 1) * DAY_MS - now) / 1_000));
}

function dailyCapResponse(now: number): Response {
  const response = errorResponse(429, "rate_limited");
  response.headers.set("retry-after", String(secondsToNextUTCDay(now)));
  return response;
}

type CodeLimitEnv = Partial<Record<"NEW_EMAIL_CODES_PER_DAY" | "UNVERIFIED_NEW_EMAIL_CODES_PER_DAY", unknown>>;

export interface NewEmailSend {
  day: number;
  unverified: boolean;
}

export interface CodeRequestGate {
  response: Response | null;
  counted: NewEmailSend | null;
}

function dailyLimit(value: unknown, fallback: number): number {
  const raw = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!/^[0-9]{1,7}$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return parsed <= MAX_CODES_PER_DAY ? parsed : fallback;
}

export function newEmailCodeLimits(env: Env): { perDay: number; unverifiedPerDay: number } {
  const vars = env as unknown as CodeLimitEnv;
  return {
    perDay: dailyLimit(vars.NEW_EMAIL_CODES_PER_DAY, DEFAULT_NEW_EMAIL_CODES_PER_DAY),
    unverifiedPerDay: dailyLimit(vars.UNVERIFIED_NEW_EMAIL_CODES_PER_DAY, DEFAULT_UNVERIFIED_NEW_EMAIL_CODES_PER_DAY),
  };
}

export function utcDay(now: number): number {
  return Math.floor(now / DAY_MS);
}

export async function gateCodeRequest(request: Request, env: Env, now = Date.now()): Promise<CodeRequestGate> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== OTP_SEND_PATH) return { response: null, counted: null };

  const parsed = await codeRequest(request);
  if (!parsed) return { response: errorResponse(400, "invalid_email"), counted: null };
  const { email, signsIn } = parsed;

  const review = reviewSignIn(env as unknown as Partial<Record<"REVIEW_EMAIL" | "REVIEW_SIGNIN_CODE", unknown>>);
  const reviewer = isReviewEmail(review, email);
  const disposable = isDisposableEmail(email);
  const opensAccount = signsIn && !reviewer;
  const unverified = turnstileSecret(env) !== null && !carriesCaptcha(request);
  const limits = newEmailCodeLimits(env);
  const day = utcDay(now);
  const windowCutoff = now - RECIPIENT_WINDOW_MS;
  const key = await recipientKey(email, env.BETTER_AUTH_SECRET);
  const [result, , health, account, count] = await env.DB.batch<{ blocked_until?: number; known?: number }>([
    env.DB.prepare(
      `INSERT INTO otp_recipient_rate_limits
        (recipient_key, window_started_at, attempts, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(recipient_key) DO UPDATE SET
         window_started_at = CASE
           WHEN window_started_at <= ? THEN excluded.window_started_at
           ELSE window_started_at
         END,
         attempts = CASE
           WHEN window_started_at <= ? THEN 1
           ELSE attempts + 1
         END,
         updated_at = excluded.updated_at
       WHERE window_started_at <= ? OR attempts < ?`,
    ).bind(key, now, now, windowCutoff, windowCutoff, windowCutoff, reviewer ? REVIEW_MAX_ATTEMPTS : RECIPIENT_MAX_ATTEMPTS),
    env.DB.prepare(
      "DELETE FROM otp_recipient_rate_limits WHERE updated_at < ?",
    ).bind(now - RETENTION_MS),
    env.DB.prepare("SELECT blocked_until FROM email_health WHERE id = 1"),
    env.DB.prepare('SELECT EXISTS (SELECT 1 FROM "user" WHERE email = ?) AS known').bind(email),
    env.DB.prepare(
      `INSERT INTO otp_new_email_days (day, sent, unverified)
       SELECT ?1, 1, ?2
        WHERE ?3 = 1
          AND NOT EXISTS (SELECT 1 FROM "user" WHERE email = ?4)
          AND EXISTS (SELECT 1 FROM otp_recipient_rate_limits WHERE recipient_key = ?5 AND updated_at = ?6)
          AND ?7 > 0
          AND (?2 = 0 OR ?8 > 0)
       ON CONFLICT(day) DO UPDATE SET
         sent = sent + 1,
         unverified = unverified + excluded.unverified
       WHERE sent < ?7 AND (excluded.unverified = 0 OR unverified < ?8)`,
    ).bind(day, unverified ? 1 : 0, opensAccount && !disposable ? 1 : 0, email, key, now, limits.perDay, limits.unverifiedPerDay),
  ]);

  if (result.meta.changes === 0) return { response: json({ success: true }), counted: null };
  const counted = count.meta.changes === 1 ? { day, unverified } : null;
  const known = Boolean(account?.results[0]?.known);
  if (!known && opensAccount && disposable) return { response: errorResponse(400, "invalid_email"), counted };
  if (!known && opensAccount && !counted) return { response: dailyCapResponse(now), counted };
  const blocked = (health?.results[0]?.blocked_until ?? 0) > now;
  return { response: blocked && !reviewer ? errorResponse(503, "email_unavailable") : null, counted };
}

export async function releaseNewEmailSend(env: Env, counted: NewEmailSend): Promise<void> {
  await env.DB.prepare(
    `UPDATE otp_new_email_days
        SET sent = MAX(sent - 1, 0),
            unverified = MAX(unverified - ?, 0)
      WHERE day = ?`,
  ).bind(counted.unverified ? 1 : 0, counted.day).run();
}
