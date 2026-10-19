import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { isDisposableEmail } from "../src/disposable-email";
import { noteEmailFailure } from "../src/email-health";
import worker from "../src/index";
import { DEFAULT_NEW_EMAIL_CODES_PER_DAY, DEFAULT_UNVERIFIED_NEW_EMAIL_CODES_PER_DAY, newEmailCodeLimits, utcDay } from "../src/otp-rate-limit";

const BASE_URL = "https://auth.laterdog.test";
const SEND_PATH = "/api/auth/email-otp/send-verification-otp";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
const TEST_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";

function withVars(vars: Record<string, string>, mail?: { send: (message: unknown) => Promise<unknown> }): Env {
  return { ...env, ...vars, ...(mail ? { EMAIL: mail } : {}) } as unknown as Env;
}

let ipCounter = 0;

function nextIP() {
  ipCounter += 1;
  return `192.0.2.${(ipCounter % 250) + 1}`;
}

interface CodeRequestOptions {
  vars?: Record<string, string>;
  captcha?: string;
  mail?: { send: (message: unknown) => Promise<unknown> };
}

async function postCode(body: string, options: CodeRequestOptions = {}) {
  const headers = new Headers({ "content-type": "application/json", "cf-connecting-ip": nextIP() });
  if (options.captcha) headers.set("x-captcha-response", options.captcha);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${SEND_PATH}`, {
    method: "POST",
    headers,
    body,
  }), withVars(options.vars ?? {}, options.mail), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function askForCode(email: string, options: CodeRequestOptions & { type?: string } = {}) {
  return postCode(JSON.stringify({ email, type: options.type ?? "sign-in" }), options);
}

async function person(email: string): Promise<void> {
  const at = new Date().toISOString();
  await env.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
    .bind(crypto.randomUUID(), email.split("@")[0], email, at, at).run();
}

async function today() {
  return env.DB.prepare("SELECT sent, unverified FROM otp_new_email_days WHERE day = ?")
    .bind(utcDay(Date.now())).first<{ sent: number; unverified: number }>();
}

async function codeExists(email: string) {
  const row = await env.DB.prepare('SELECT 1 AS found FROM "verification" WHERE identifier = ?').bind(`sign-in-otp-${email}`).first();
  return row !== null;
}

function fakeSiteverify(success: boolean) {
  const calls: Array<{ secret: string; response: string }> = [];
  const real = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== SITEVERIFY) return real(input, init);
    calls.push(JSON.parse(String(init?.body)) as { secret: string; response: string });
    return Response.json({ success, hostname: "auth.laterdog.test" });
  });
  return { calls, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a daily cap on codes to addresses with no account", () => {
  it("defaults below the Email Service quota and reads its settings", () => {
    expect(newEmailCodeLimits(env)).toEqual({ perDay: 200, unverifiedPerDay: 100 });
    expect(newEmailCodeLimits(withVars({ NEW_EMAIL_CODES_PER_DAY: "nope", UNVERIFIED_NEW_EMAIL_CODES_PER_DAY: "-3" })))
      .toEqual({ perDay: DEFAULT_NEW_EMAIL_CODES_PER_DAY, unverifiedPerDay: DEFAULT_UNVERIFIED_NEW_EMAIL_CODES_PER_DAY });
    expect(newEmailCodeLimits(withVars({ NEW_EMAIL_CODES_PER_DAY: "25", UNVERIFIED_NEW_EMAIL_CODES_PER_DAY: "0" })))
      .toEqual({ perDay: 25, unverifiedPerDay: 0 });
  });

  it("stops new sign-up codes at the cap while people with an account and App Review still get theirs", async () => {
    const vars = { NEW_EMAIL_CODES_PER_DAY: "2" };
    await person("member@example.com");
    expect((await askForCode("first@example.com", { vars })).status).toBe(200);
    expect((await askForCode("second@example.com", { vars })).status).toBe(200);
    const capped = await askForCode("third@example.com", { vars });
    expect(capped.status).toBe(429);
    await expect(capped.json()).resolves.toEqual({ error: "rate_limited" });
    const retryAfter = Number(capped.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
    expect(await codeExists("third@example.com")).toBe(false);
    expect((await askForCode("member@example.com", { vars })).status).toBe(200);
    expect(await codeExists("member@example.com")).toBe(true);
    expect((await askForCode("appreview@later.dog", { vars })).status).toBe(200);
    expect(await today()).toEqual({ sent: 2, unverified: 0 });
  });

  it("does not count a code that never went out", async () => {
    await noteEmailFailure(env.DB, Object.assign(new Error("E_RATE_LIMIT_EXCEEDED"), { code: "E_RATE_LIMIT_EXCEEDED" }));
    const refused = await askForCode("waiting@example.com");
    expect(refused.status).toBe(503);
    expect(await today()).toEqual({ sent: 0, unverified: 0 });
  });

  it("counts a repeat request the recipient limit swallowed only once", async () => {
    for (let index = 0; index < 4; index += 1) {
      expect((await askForCode("repeat@example.com")).status).toBe(200);
    }
    expect(await today()).toEqual({ sent: 3, unverified: 0 });
  });
});

describe("code requests the guards cannot read", () => {
  it("are refused before Better Auth can send anything", async () => {
    const label = (letter: string) => letter.repeat(60);
    const long = `${label("a")}@${[label("b"), label("c"), label("d"), label("e")].join(".")}.com`;
    expect(long.length).toBeGreaterThan(300);
    expect(z.email().safeParse(long).success).toBe(true);
    const mail = { send: vi.fn(async () => ({ messageId: "never" })) };

    const tooLong = await askForCode(long, { mail });
    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toEqual({ error: "invalid_email" });
    const notJSON = await postCode("email=bot@example.com", { mail });
    expect(notJSON.status).toBe(400);
    await expect(notJSON.json()).resolves.toEqual({ error: "invalid_email" });
    const noEmail = await postCode(JSON.stringify({ type: "sign-in" }), { mail });
    expect(noEmail.status).toBe(400);

    expect(mail.send).not.toHaveBeenCalled();
    expect(await codeExists(long)).toBe(false);
    expect(await today()).toBeNull();
  });

  it("still sends a normal code through the same mail binding", async () => {
    const mail = { send: vi.fn(async () => ({ messageId: "sent" })) };
    expect((await askForCode("Normal@Example.com", { mail })).status).toBe(200);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(await codeExists("normal@example.com")).toBe(true);
    expect(await today()).toEqual({ sent: 1, unverified: 0 });
  });

  it("only counts sign-in codes, the one type Better Auth sends to an address with no account", async () => {
    const mail = { send: vi.fn(async () => ({ messageId: "never" })) };
    expect((await askForCode("stranger@example.com", { mail, type: "forget-password" })).status).toBe(200);
    expect((await askForCode("stranger-two@example.com", { mail, type: "email-verification" })).status).toBe(200);
    expect(mail.send).not.toHaveBeenCalled();
    expect(await today()).toBeNull();
  });
});

describe("throwaway addresses", () => {
  it("recognises disposable domains and their subdomains only", () => {
    expect(isDisposableEmail("bot@mailinator.com")).toBe(true);
    expect(isDisposableEmail("bot@eu.Mailinator.com")).toBe(true);
    expect(isDisposableEmail("ada@example.com")).toBe(false);
    expect(isDisposableEmail("ada@notmailinator.com")).toBe(false);
    expect(isDisposableEmail("ada@com")).toBe(false);
  });

  it("refuses new sign-ups from them without sending or counting", async () => {
    const refused = await askForCode("bot@yopmail.com");
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toEqual({ error: "invalid_email" });
    expect(await codeExists("bot@yopmail.com")).toBe(false);
    expect(await today()).toBeNull();
  });

  it("still lets an existing account on such a domain sign in", async () => {
    await person("old-friend@mailinator.com");
    expect((await askForCode("old-friend@mailinator.com")).status).toBe(200);
    expect(await codeExists("old-friend@mailinator.com")).toBe(true);
  });
});

describe("Turnstile on the sign-up code", () => {
  it("is off until the secret exists, so a token is never checked", async () => {
    const siteverify = fakeSiteverify(false);
    expect((await askForCode("no-secret@example.com", { captcha: "anything" })).status).toBe(200);
    expect(siteverify.calls).toEqual([]);
    expect(await today()).toEqual({ sent: 1, unverified: 0 });
  });

  it("checks a token when one is sent and refunds the cap when it fails", async () => {
    const vars = { TURNSTILE_SECRET_KEY: TEST_TURNSTILE_SECRET };
    const passing = fakeSiteverify(true);
    expect((await askForCode("human@example.com", { vars, captcha: "token-1" })).status).toBe(200);
    expect(passing.calls).toEqual([expect.objectContaining({ secret: TEST_TURNSTILE_SECRET, response: "token-1" })]);
    vi.restoreAllMocks();

    const failing = fakeSiteverify(false);
    const refused = await askForCode("bot@example.com", { vars, captcha: "forged" });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toEqual({ error: "captcha_failed" });
    expect(failing.calls).toHaveLength(1);
    expect(await codeExists("bot@example.com")).toBe(false);
    expect(await today()).toEqual({ sent: 1, unverified: 0 });
  });

  it("accepts a production token only from the accounts page hostname", async () => {
    const vars = { TURNSTILE_SECRET_KEY: "0x4AAAAAAAproductionlookingsecret" };
    const real = globalThis.fetch;
    let hostname = "evil.example";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SITEVERIFY) return real(input, init);
      return Response.json({ success: true, hostname });
    });
    const elsewhere = await askForCode("borrowed-widget@example.com", { vars, captcha: "token-elsewhere" });
    expect(elsewhere.status).toBe(403);
    await expect(elsewhere.json()).resolves.toEqual({ error: "captcha_failed" });
    expect(await today()).toEqual({ sent: 0, unverified: 0 });
    hostname = "accounts.later.dog";
    expect((await askForCode("accounts-page@example.com", { vars, captcha: "token-here" })).status).toBe(200);
    expect(await today()).toEqual({ sent: 1, unverified: 0 });
  });

  it("lets apps that send no token sign up from a smaller share, and never blocks existing accounts", async () => {
    const vars = { TURNSTILE_SECRET_KEY: TEST_TURNSTILE_SECRET, UNVERIFIED_NEW_EMAIL_CODES_PER_DAY: "1" };
    const siteverify = fakeSiteverify(true);
    await person("returning@example.com");
    expect((await askForCode("app-one@example.com", { vars })).status).toBe(200);
    expect((await askForCode("app-two@example.com", { vars })).status).toBe(429);
    expect((await askForCode("returning@example.com", { vars })).status).toBe(200);
    expect((await askForCode("web-human@example.com", { vars, captcha: "token-2" })).status).toBe(200);
    expect(siteverify.calls).toHaveLength(1);
    expect(await today()).toEqual({ sent: 2, unverified: 1 });
  });

  it("puts the widget on the web sign-in pages only when both keys exist", async () => {
    const page = async (vars: Record<string, string>) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(`${BASE_URL}/cloud`), withVars(vars), ctx);
      await waitOnExecutionContext(ctx);
      return { html: await response.text(), csp: response.headers.get("content-security-policy") ?? "" };
    };
    const plain = await page({});
    expect(plain.html).not.toContain("challenges.cloudflare.com");
    expect(plain.csp).not.toContain("challenges.cloudflare.com");
    const siteKeyOnly = await page({ TURNSTILE_SITE_KEY: TEST_TURNSTILE_SITE_KEY });
    expect(siteKeyOnly.html).not.toContain("data-turnstile");
    const both = await page({ TURNSTILE_SITE_KEY: TEST_TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY: TEST_TURNSTILE_SECRET });
    expect(both.html).toContain(`data-turnstile="${TEST_TURNSTILE_SITE_KEY}"`);
    expect(both.html).toContain('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>');
    expect(both.csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(both.csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    const unsafe = await page({ TURNSTILE_SITE_KEY: '"><script>', TURNSTILE_SECRET_KEY: TEST_TURNSTILE_SECRET });
    expect(unsafe.html).not.toContain("data-turnstile");
  });
});
