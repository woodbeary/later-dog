import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { homeAllowed, type HomeState, type HomesService, type HomeSummary } from "../src/cloud";
import { OWNER_EMAILS_PER_DAY, sendOwnerEmail, type OwnerEmailSender } from "../src/owner-mail";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";

const BASE_URL = "https://auth.laterdog.test";

function fakeHomes() {
  const homes = new Map<string, { state: HomeState; origin: string }>();
  const removed: string[] = [];
  const summary = (accountId: string): HomeSummary | null => {
    const home = homes.get(accountId);
    if (!home) return null;
    return home.state === "setting_up" ? { ...home, setup: { step: "starting" } } : { ...home };
  };
  const service: HomesService = {
    async open(accountId) {
      if (!homes.has(accountId)) homes.set(accountId, { state: "setting_up", origin: `https://h${accountId.replace(/[^a-f0-9]/g, "").slice(0, 24).padEnd(24, "0")}-home.later.dog` });
      return summary(accountId) as HomeSummary;
    },
    async summary(accountId) {
      return summary(accountId);
    },
    async pair(accountId, input) {
      const home = homes.get(accountId);
      if (!home || home.state !== "ready") return { ok: false, summary: summary(accountId) };
      return { ok: true, origin: home.origin, code: "ABCD-EFGH-JKLM", credential: "laterdog_pair_0123456789abcdefghij", expiresAt: Date.now() + input.ttlSeconds * 1000 };
    },
    async remove(accountId) {
      homes.delete(accountId);
      removed.push(accountId);
      return { removed: 3 };
    },
  };
  return { service, homes, removed, ready: (accountId: string) => { homes.get(accountId)!.state = "ready"; } };
}

function harness() {
  const homes = fakeHomes();
  const worker = createWorker(fetch, () => homes.service);
  async function call(path: string, options: { method?: string; token?: string; body?: unknown; ip?: string } = {}) {
    const headers = new Headers({ "cf-connecting-ip": options.ip ?? "203.0.113.7" });
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set("content-type", "application/json");
    }
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${BASE_URL}${path}`, { method: options.method ?? "GET", headers, body }), env, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  async function signIn(email: string) {
    const ctx = createExecutionContext();
    const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
    const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
    await waitOnExecutionContext(ctx);
    const response = await call("/api/auth/sign-in/email-otp", { method: "POST", body: { email, otp, name: email.split("@", 1)[0] } });
    expect(response.status).toBe(200);
    const result = await response.json<{ user: { id: string } }>();
    const token = response.headers.get("set-auth-token");
    if (!token) throw new Error("no bearer");
    return { token, userId: result.user.id };
  }
  return { homes, call, signIn };
}

async function enroll(call: ReturnType<typeof harness>["call"], ip = "203.0.113.7") {
  const response = await call("/api/cloud/desktop/authorize", { method: "POST", body: { deviceName: "Ada's MacBook Air", platform: "darwin", appVersion: "0.3.25" }, ip });
  expect(response.status).toBe(200);
  return response.json<{ cloudContractVersion: number; deviceCode: string; userCode: string; verificationUriComplete: string; expiresIn: number; interval: number }>();
}

describe("later.dog Cloud for the desktop app", () => {
  it("signs a desktop in with a device code, exactly as the app expects", async () => {
    const { call, signIn, homes } = harness();
    const started = await enroll(call);
    expect(started.cloudContractVersion).toBe(1);
    expect(started.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.userCode).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(started.verificationUriComplete).toBe(`${readConfig(env).authBaseURL}/cloud/desktop?code=${started.userCode}`);
    expect(started.expiresIn).toBeGreaterThan(0);
    expect(started.expiresIn).toBeLessThanOrEqual(1800);
    expect(started.interval).toBeGreaterThanOrEqual(5);

    const pending = await call("/api/cloud/desktop/token", { method: "POST", body: { deviceCode: started.deviceCode } });
    expect(pending.status).toBe(400);
    await expect(pending.json()).resolves.toEqual({ error: "authorization_pending" });
    const hurried = await call("/api/cloud/desktop/token", { method: "POST", body: { deviceCode: started.deviceCode } });
    await expect(hurried.json()).resolves.toMatchObject({ error: "slow_down" });

    const details = await call(`/api/cloud/desktop/authorization?code=${started.userCode}`);
    await expect(details.json()).resolves.toMatchObject({ deviceName: "Ada's MacBook Air", platform: "darwin" });

    const account = await signIn("ada@example.com");
    expect((await call("/api/cloud/desktop/approve", { method: "POST", body: { userCode: started.userCode, decision: "allow" } })).status).toBe(401);
    const approved = await call("/api/cloud/desktop/approve", { method: "POST", token: account.token, body: { userCode: started.userCode, decision: "allow" } });
    expect(approved.status).toBe(200);

    const issued = await call("/api/cloud/desktop/token", { method: "POST", body: { deviceCode: started.deviceCode } });
    expect(issued.status).toBe(200);
    const grant = await issued.json<{ cloudContractVersion: number; accessToken: string; expiresAt: number; device: { id: string }; account: { id: string; email: string } }>();
    expect(grant.cloudContractVersion).toBe(1);
    expect(grant.accessToken).toMatch(/^omc_[A-Za-z0-9_-]{43}$/);
    expect(grant.account).toEqual({ id: account.userId, email: "ada@example.com" });
    expect((await call("/api/cloud/desktop/token", { method: "POST", body: { deviceCode: started.deviceCode } })).status).toBe(400);

    const setting = await call("/api/cloud/desktop/session", { token: grant.accessToken });
    expect(setting.status).toBe(200);
    const first = await setting.json<{ entitlement: { plan: string; tier: string; status: string; expiresAt: number }; cloud: { state: string; origin: string; pairingAvailable: boolean; setup: { step: string } } }>();
    expect(first.entitlement).toMatchObject({ plan: "pro", tier: "beta", status: "active" });
    expect(first.entitlement.expiresAt).toBeGreaterThan(Date.now());
    expect(first.cloud).toMatchObject({ state: "setting_up", pairingAvailable: false, setup: { step: "starting" } });
    expect(first.cloud.origin).toMatch(/^https:\/\/h[0-9a-f]{24}-home\.later\.dog$/);

    expect((await call("/api/cloud/desktop/pairing", { method: "POST", token: grant.accessToken, body: {} })).status).toBe(409);
    homes.ready(account.userId);
    const ready = await (await call("/api/cloud/desktop/session", { token: grant.accessToken })).json<{ cloud: { state: string; pairingAvailable: boolean } }>();
    expect(ready.cloud).toMatchObject({ state: "ready", pairingAvailable: true });
    const paired = await call("/api/cloud/desktop/pairing", { method: "POST", token: grant.accessToken, body: {} });
    expect(paired.status).toBe(200);
    const pairing = await paired.json<{ cloudContractVersion: number; origin: string; code: string; expiresAt: number }>();
    expect(pairing.cloudContractVersion).toBe(1);
    expect(pairing.origin).toBe(first.cloud.origin);
    expect(pairing.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(pairing.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);

    expect((await call("/api/cloud/desktop/session", { method: "DELETE", token: grant.accessToken })).status).toBe(200);
    const ended = await call("/api/cloud/desktop/session", { token: grant.accessToken });
    expect(ended.status).toBe(401);
    await expect(ended.json()).resolves.toEqual({ error: "invalid_token" });
  });

  it("ends the sign-in when the person says it isn't them", async () => {
    const { call, signIn } = harness();
    const started = await enroll(call, "203.0.113.8");
    const account = await signIn("grace@example.com");
    await call("/api/cloud/desktop/approve", { method: "POST", token: account.token, body: { userCode: started.userCode, decision: "deny" } });
    const refused = await call("/api/cloud/desktop/token", { method: "POST", body: { deviceCode: started.deviceCode } });
    await expect(refused.json()).resolves.toEqual({ error: "access_denied" });
  });

  it("limits how many sign-ins one network can start", async () => {
    const { call } = harness();
    for (let attempt = 0; attempt < 10; attempt += 1) await enroll(call, "198.51.100.9");
    const limited = await call("/api/cloud/desktop/authorize", { method: "POST", body: { deviceName: "x", platform: "darwin" }, ip: "198.51.100.9" });
    expect(limited.status).toBe(429);
  });

  it("serves the sign-in pages with a strict content policy", async () => {
    const { call } = harness();
    const page = await call("/cloud/desktop?code=ABCDE-FGHJK");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain("Connect later.dog on your computer");
  });
});

describe("later.dog Cloud for the phone app", () => {
  it("opens the person's home and hands the phone a one-time pairing code", async () => {
    const { call, signIn, homes } = harness();
    expect((await call("/api/cloud/home", { method: "POST", body: {} })).status).toBe(401);
    const account = await signIn("lin@example.com");
    const opened = await (await call("/api/cloud/home", { method: "POST", token: account.token, body: {} })).json<{ account: { email: string }; cloud: { state: string } }>();
    expect(opened.account.email).toBe("lin@example.com");
    expect(opened.cloud.state).toBe("setting_up");
    expect((await call("/api/cloud/pairing", { method: "POST", token: account.token, body: {} })).status).toBe(409);
    homes.ready(account.userId);
    const paired = await call("/api/cloud/pairing", { method: "POST", token: account.token, body: {} });
    expect(paired.status).toBe(200);
    await expect(paired.json()).resolves.toMatchObject({ cloudContractVersion: 1, code: "ABCD-EFGH-JKLM" });
  });

  it("deletes the account, its home and every sign-in", async () => {
    const { call, signIn, homes } = harness();
    const account = await signIn("del@example.com");
    await call("/api/cloud/home", { method: "POST", token: account.token, body: {} });
    const deleted = await call("/api/cloud/account", { method: "DELETE", token: account.token });
    expect(deleted.status).toBe(200);
    expect(homes.removed).toEqual([account.userId]);
    const gone = await env.DB.prepare('SELECT COUNT(*) AS count FROM "user" WHERE id = ?').bind(account.userId).first<{ count: number }>();
    expect(gone?.count).toBe(0);
    expect((await call("/api/cloud/home", { method: "POST", token: account.token, body: {} })).status).toBe(401);
  });

  it("stops giving out homes at the beta cap, but keeps the ones it gave", async () => {
    const { signIn } = harness();
    const first = await signIn("cap-one@example.com");
    const second = await signIn("cap-two@example.com");
    const capped = { DB: env.DB, CLOUD_HOME_CAP: "1" } as unknown as Env;
    expect(await homeAllowed(capped, first.userId)).toBe(true);
    expect(await homeAllowed(capped, second.userId)).toBe(false);
    expect(await homeAllowed(capped, first.userId)).toBe(true);
  });
});

describe("an accounts service without desktop tunnels", () => {
  it("needs no Cloudflare API token and refuses tunnel work politely", async () => {
    const quiet = { ...env, MANAGED_ENDPOINTS: "off", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_ZONE_ID: "" } as unknown as Env;
    const config = readConfig(quiet);
    expect(config.managedEndpoints).toBe(false);
    expect(config.cloudflare.apiToken).toBe("");
  });
});

describe("dogs emailing their owner", () => {
  it("sends only to the account's own email, with attachments, and caps a day's emails", async () => {
    const { signIn } = harness();
    const account = await signIn("owner@example.com");
    const sent: Parameters<OwnerEmailSender["send"]>[0][] = [];
    const sender: OwnerEmailSender = { send: async (message) => { sent.push(message); } };
    const email = { subject: "Your file", text: "Here it is.", attachments: [{ filename: "scan.pdf", type: "application/pdf", content: "JVBERi0=" }] };
    expect(await sendOwnerEmail(env, account.userId, email, sender, 1_800_000_000_000)).toEqual({ ok: true });
    expect(sent[0]).toMatchObject({
      to: "owner@example.com",
      from: { name: "later.dog" },
      subject: "Your file",
      attachments: [{ filename: "scan.pdf", type: "application/pdf", content: "JVBERi0=", disposition: "attachment" }],
    });
    for (let index = 1; index < OWNER_EMAILS_PER_DAY; index += 1) await sendOwnerEmail(env, account.userId, email, sender, 1_800_000_000_000);
    expect(await sendOwnerEmail(env, account.userId, email, sender, 1_800_000_000_000)).toMatchObject({ ok: false, status: 429 });
    expect(await sendOwnerEmail(env, account.userId, email, sender, 1_800_000_000_000 + 86_400_000)).toEqual({ ok: true });
  });

  it("refuses a home whose account is gone and reports a failed send", async () => {
    const failing: OwnerEmailSender = { send: async () => { throw new Error("quota"); } };
    expect(await sendOwnerEmail(env, "missing-account", { subject: "s", text: "t", attachments: [] }, failing)).toMatchObject({ ok: false, status: 404 });
    const { signIn } = harness();
    const account = await signIn("fail@example.com");
    expect(await sendOwnerEmail(env, account.userId, { subject: "s", text: "t", attachments: [] }, failing)).toMatchObject({ ok: false, status: 502 });
  });
});

describe("later.dog for iPhone link", () => {
  it("waits on a plain page until the TestFlight link is set, then sends people there", async () => {
    const { cloudPage, phoneAppTarget } = await import("../src/cloud-pages");
    const waiting = cloudPage(new Request(`${BASE_URL}/iphone`));
    expect(waiting?.status).toBe(200);
    expect(await waiting?.text()).toContain("later.dog for iPhone");
    const testflight = phoneAppTarget("https://testflight.apple.com/join/AbCdEf12");
    expect(testflight).toBe("https://testflight.apple.com/join/AbCdEf12");
    const sent = cloudPage(new Request(`${BASE_URL}/iphone`), testflight);
    expect(sent?.status).toBe(302);
    expect(sent?.headers.get("location")).toBe("https://testflight.apple.com/join/AbCdEf12");
    expect(phoneAppTarget("https://evil.example/join/x")).toBeNull();
    expect(phoneAppTarget("http://testflight.apple.com/join/x")).toBeNull();
    expect(phoneAppTarget("")).toBeNull();
    expect(cloudPage(new Request(`${BASE_URL}/iphone`, { method: "POST" }))).toBeNull();
  });
});

describe("privacy policy and terms", () => {
  it("serve plain pages that say how to delete everything", async () => {
    const { cloudPage } = await import("../src/cloud-pages");
    const privacy = cloudPage(new Request(`${BASE_URL}/privacy`));
    expect(privacy?.status).toBe(200);
    const text = await privacy!.text();
    expect(text).toContain("Privacy Policy");
    expect(text).toContain("Delete account");
    expect(text).toContain("No ads, no tracking");
    const terms = cloudPage(new Request(`${BASE_URL}/terms`));
    expect(terms?.status).toBe(200);
    expect(await terms!.text()).toContain("Apache License 2.0");
    expect(privacy!.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});
