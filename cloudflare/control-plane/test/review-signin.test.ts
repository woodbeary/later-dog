import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import { isReviewEmail, reviewSignIn } from "../src/review-signin";

const BASE_URL = "https://auth.laterdog.test";
const REVIEW_EMAIL = "appreview@later.dog";
const REVIEW_CODE = "31415926";

async function call(path: string, body: unknown, ip = "198.51.100.40") {
  const worker = createWorker(fetch);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("App Review sign-in", () => {
  it("is on only with a real address and an 8-digit code", () => {
    expect(reviewSignIn({ REVIEW_EMAIL: " AppReview@Later.dog ", REVIEW_SIGNIN_CODE: "31415926" })).toEqual({ email: REVIEW_EMAIL, code: REVIEW_CODE });
    expect(reviewSignIn({ REVIEW_EMAIL: REVIEW_EMAIL })).toBeNull();
    expect(reviewSignIn({ REVIEW_EMAIL: REVIEW_EMAIL, REVIEW_SIGNIN_CODE: "1234" })).toBeNull();
    expect(reviewSignIn({ REVIEW_EMAIL: REVIEW_EMAIL, REVIEW_SIGNIN_CODE: "abcdefgh" })).toBeNull();
    expect(reviewSignIn({ REVIEW_EMAIL: "not an email", REVIEW_SIGNIN_CODE: REVIEW_CODE })).toBeNull();
    expect(reviewSignIn({ REVIEW_EMAIL: "", REVIEW_SIGNIN_CODE: REVIEW_CODE })).toBeNull();
    expect(isReviewEmail({ email: REVIEW_EMAIL, code: REVIEW_CODE }, "APPREVIEW@later.dog")).toBe(true);
    expect(isReviewEmail(null, REVIEW_EMAIL)).toBe(false);
  });

  it("signs the reviewer in with the fixed code through the same routes the phone uses", async () => {
    const sent = await call("/api/auth/email-otp/send-verification-otp", { email: REVIEW_EMAIL, type: "sign-in" });
    expect(sent.status).toBe(200);
    const wrong = await call("/api/auth/sign-in/email-otp", { email: REVIEW_EMAIL, otp: "27182818" });
    expect(wrong.ok).toBe(false);
    const signedIn = await call("/api/auth/sign-in/email-otp", { email: REVIEW_EMAIL, otp: REVIEW_CODE });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-auth-token")).toBeTruthy();
  });

  it("signs a returning reviewer in again and again, right after each code request", async () => {
    const worker = createWorker(fetch);
    const request = (path: string, body: unknown) => new Request(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.42" },
      body: JSON.stringify(body),
    });
    const pending: ExecutionContext[] = [];
    for (let round = 0; round < 5; round += 1) {
      const sendContext = createExecutionContext();
      pending.push(sendContext);
      const sent = await worker.fetch(request("/api/auth/email-otp/send-verification-otp", { email: REVIEW_EMAIL, type: "sign-in" }), env, sendContext);
      expect(sent.status).toBe(200);
      const signInContext = createExecutionContext();
      pending.push(signInContext);
      const signedIn = await worker.fetch(request("/api/auth/sign-in/email-otp", { email: REVIEW_EMAIL, otp: REVIEW_CODE }), env, signInContext);
      expect({ round, status: signedIn.status, body: signedIn.ok ? null : await signedIn.json() }).toEqual({ round, status: 200, body: null });
    }
    for (const context of pending) await waitOnExecutionContext(context);
  });

  it("signs in again on a phone that still holds the cookie from its last sign-in", async () => {
    const worker = createWorker(fetch);
    const request = (path: string, body: unknown) => new Request(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.43", cookie: "__Secure-better-auth.session_token=left.from.last.time" },
      body: JSON.stringify(body),
    });
    const sendContext = createExecutionContext();
    const sent = await worker.fetch(request("/api/auth/email-otp/send-verification-otp", { email: REVIEW_EMAIL, type: "sign-in" }), env, sendContext);
    await waitOnExecutionContext(sendContext);
    expect(sent.status).toBe(200);
    const signInContext = createExecutionContext();
    const signedIn = await worker.fetch(request("/api/auth/sign-in/email-otp", { email: REVIEW_EMAIL, otp: REVIEW_CODE }), env, signInContext);
    await waitOnExecutionContext(signInContext);
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-auth-token")).toBeTruthy();
  });

  it("still refuses a browser sign-in from a page it does not trust", async () => {
    const response = await call("/api/auth/email-otp/send-verification-otp", { email: REVIEW_EMAIL, type: "sign-in" }, "198.51.100.44");
    expect(response.status).toBe(200);
    const worker = createWorker(fetch);
    const ctx = createExecutionContext();
    const forged = await worker.fetch(new Request(`${BASE_URL}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.44", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", cookie: "__Secure-better-auth.session_token=victim" },
      body: JSON.stringify({ email: REVIEW_EMAIL, type: "sign-in" }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(forged.status).toBe(403);
  });

  it("gives everyone else their own random code", async () => {
    const ctx = createExecutionContext();
    const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
    const codes = new Set<string>();
    for (const email of ["ada@example.com", "grace@example.com", "lin@example.com"]) {
      codes.add(await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } }));
    }
    await waitOnExecutionContext(ctx);
    expect(codes.has(REVIEW_CODE)).toBe(false);
    expect([...codes].every((code) => /^[0-9]{8}$/.test(code))).toBe(true);
  });
});
