import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config";
import type { TransactionalEmailSender } from "../src/email";
import worker from "../src/index";

const BASE_URL = readConfig(env).authBaseURL;
const EMAIL = "desktop-fetch@example.com";
const SEND_PATH = "/api/auth/email-otp/send-verification-otp";
const SIGN_IN_PATH = "/api/auth/sign-in/email-otp";

function desktopFixture() {
  const messages: Parameters<TransactionalEmailSender["send"]>[0][] = [];
  const sender: TransactionalEmailSender = {
    async send(message) {
      messages.push(message);
    },
  };
  const fixtureEnv = { ...env, EMAIL: sender as unknown as Env["EMAIL"] };
  async function call(path: string, body: unknown, origin?: string) {
    const headers = new Headers({
      "content-type": "application/json",
      "cf-connecting-ip": "198.51.100.78",
      "sec-fetch-mode": "cors",
    });
    if (origin) headers.set("origin", origin);
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${BASE_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }), fixtureEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  async function sendCode() {
    const response = await call(SEND_PATH, { email: EMAIL, type: "sign-in" }, BASE_URL);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(messages).toHaveLength(1);
    expect(messages[0].to).toBe(EMAIL);
    const code = messages[0].text.match(/Your one-time code is: ([0-9]{8})/)?.[1];
    expect(code).toMatch(/^[0-9]{8}$/);
    if (!code) throw new Error("The fixture email did not contain a sign-in code");
    return code;
  }
  return { call, messages, sendCode };
}

describe("desktop fetch metadata at the Better Auth boundary", () => {
  it("rejects native fetch metadata without an Origin when asking for an email code", async () => {
    const fixture = desktopFixture();
    const sent = await fixture.call(SEND_PATH, { email: EMAIL, type: "sign-in" });
    expect(sent.status).toBe(403);
    await expect(sent.json()).resolves.toEqual({ error: "forbidden" });
    expect(fixture.messages).toHaveLength(0);

    const verification = await env.DB.prepare('SELECT value FROM "verification" WHERE identifier = ?')
      .bind(`sign-in-otp-${EMAIL}`).first();
    expect(verification).toBeNull();
  });

  it("sends and verifies a real generated code with the exact accounts Origin", async () => {
    const fixture = desktopFixture();
    const code = await fixture.sendCode();
    const signedIn = await fixture.call(SIGN_IN_PATH, { email: EMAIL, otp: code }, BASE_URL);
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-auth-token")).toBeTruthy();
    const result = await signedIn.json<{ user: { email: string; emailVerified: boolean } }>();
    expect(result.user.email).toBe(EMAIL);
    expect(result.user.emailVerified).toBe(true);
  });

  it("keeps untrusted origins blocked for both sending and verifying codes", async () => {
    const fixture = desktopFixture();
    const untrustedOrigin = `${BASE_URL}.untrusted.example`;
    const sent = await fixture.call(SEND_PATH, { email: EMAIL, type: "sign-in" }, untrustedOrigin);
    expect(sent.status).toBe(403);
    expect(fixture.messages).toHaveLength(0);

    const code = await fixture.sendCode();
    const rejected = await fixture.call(SIGN_IN_PATH, { email: EMAIL, otp: code }, untrustedOrigin);
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("set-auth-token")).toBeNull();
    const accepted = await fixture.call(SIGN_IN_PATH, { email: EMAIL, otp: code }, BASE_URL);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("set-auth-token")).toBeTruthy();
  });
});
