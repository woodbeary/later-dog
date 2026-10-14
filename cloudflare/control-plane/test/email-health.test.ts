import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { DAILY_LIMIT_BLOCK_MS, emailBlocked, emailLimitCode, noteEmailFailure, RATE_LIMIT_BLOCK_MS } from "../src/email-health";
import { sendOTPEmail } from "../src/email";
import { createWorker } from "../src/index";
import { sendOwnerEmail } from "../src/owner-mail";

const NOW = 1_800_000_000_000;
const limitError = (code: string) => Object.assign(new Error(`send failed: ${code}`), { code });

async function askForCode(email: string) {
  const worker = createWorker(fetch);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://auth.laterdog.test/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.77" },
    body: JSON.stringify({ email, type: "sign-in" }),
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("when Cloudflare stops sending email", () => {
  it("recognises the daily and rate limits, by code or by message", () => {
    expect(emailLimitCode(limitError("E_DAILY_LIMIT_EXCEEDED"))).toBe("E_DAILY_LIMIT_EXCEEDED");
    expect(emailLimitCode(new Error("E_RATE_LIMIT_EXCEEDED: slow down"))).toBe("E_RATE_LIMIT_EXCEEDED");
    expect(emailLimitCode(limitError("E_DELIVERY_FAILED"))).toBeNull();
    expect(emailLimitCode(null)).toBeNull();
  });

  it("remembers a daily limit for an hour and a rate limit for a minute", async () => {
    expect(await noteEmailFailure(env.DB, limitError("E_RATE_LIMIT_EXCEEDED"), NOW)).toBe("E_RATE_LIMIT_EXCEEDED");
    expect(await emailBlocked(env.DB, NOW + RATE_LIMIT_BLOCK_MS - 1)).toBe(true);
    expect(await emailBlocked(env.DB, NOW + RATE_LIMIT_BLOCK_MS)).toBe(false);
    await noteEmailFailure(env.DB, limitError("E_DAILY_LIMIT_EXCEEDED"), NOW);
    await noteEmailFailure(env.DB, limitError("E_RATE_LIMIT_EXCEEDED"), NOW);
    expect(await emailBlocked(env.DB, NOW + DAILY_LIMIT_BLOCK_MS - 1)).toBe(true);
    expect(await noteEmailFailure(env.DB, limitError("E_DELIVERY_FAILED"), NOW)).toBeNull();
  });

  it("a failed sign-in email is noted instead of vanishing", async () => {
    const noted: unknown[] = [];
    await sendOTPEmail({ send: async () => { throw limitError("E_DAILY_LIMIT_EXCEEDED"); } }, "noreply@later.dog",
      { email: "ada@example.com", otp: "12345678", type: "sign-in" }, "request-1", async (error) => { noted.push(error); });
    expect(noted).toHaveLength(1);
  });

  it("then tells people plainly that codes can't go out, while App Review still signs in", async () => {
    expect((await askForCode("ada@example.com")).status).toBe(200);
    await noteEmailFailure(env.DB, limitError("E_DAILY_LIMIT_EXCEEDED"));
    const refused = await askForCode("grace@example.com");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "email_unavailable" });
    expect((await askForCode("appreview@later.dog")).status).toBe(200);
  });

  it("tells a dog when the day's email is used up", async () => {
    const user = await env.DB.prepare("INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?) RETURNING id")
      .bind(crypto.randomUUID(), "Lin", "lin@example.com", new Date().toISOString(), new Date().toISOString()).first<{ id: string }>();
    const result = await sendOwnerEmail(env, user!.id, { subject: "Hi", text: "There", attachments: [] }, { send: async () => { throw limitError("E_DAILY_LIMIT_EXCEEDED"); } }, NOW);
    expect(result).toEqual({ ok: false, status: 429, error: "later.dog has sent all the email it can today. Try again tomorrow." });
    expect(await emailBlocked(env.DB, NOW + 1)).toBe(true);
  });
});
