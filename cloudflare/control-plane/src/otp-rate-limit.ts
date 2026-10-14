import { z } from "zod";

import { errorResponse, json } from "./http";
import { isReviewEmail, reviewSignIn } from "./review-signin";

const OTP_SEND_PATH = "/api/auth/email-otp/send-verification-otp";
const RECIPIENT_WINDOW_MS = 15 * 60 * 1_000;
const RECIPIENT_MAX_ATTEMPTS = 3;
const REVIEW_MAX_ATTEMPTS = 20;
const RETENTION_MS = 24 * 60 * 60 * 1_000;
const recipientSchema = z.object({
  email: z.string().trim().min(1).max(254).toLowerCase(),
});

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

async function normalizedRecipient(request: Request): Promise<string | null> {
  try {
    const parsed = recipientSchema.safeParse(await request.clone().json());
    return parsed.success ? parsed.data.email : null;
  } catch {
    return null;
  }
}

export async function limitedOTPResponse(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== OTP_SEND_PATH) return null;

  const email = await normalizedRecipient(request);
  if (!email) return null;

  const review = reviewSignIn(env as unknown as Partial<Record<"REVIEW_EMAIL" | "REVIEW_SIGNIN_CODE", unknown>>);
  const reviewer = isReviewEmail(review, email);
  const now = Date.now();
  const windowCutoff = now - RECIPIENT_WINDOW_MS;
  const key = await recipientKey(email, env.BETTER_AUTH_SECRET);
  const [result, , health] = await env.DB.batch<{ blocked_until?: number }>([
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
  ]);

  if (result.meta.changes === 0) return json({ success: true });
  const blocked = (health?.results[0]?.blocked_until ?? 0) > now;
  return blocked && !reviewer ? errorResponse(503, "email_unavailable") : null;
}
