import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { homeAllowed, type HomeSummary, type HomesService } from "../src/cloud";
import { errorResponse } from "../src/http";
import { createWorker } from "../src/index";
import { alertOwner, emailServiceCode, ownerAlerts, routeLabel, serverErrorAlert, type OwnerAlertSender } from "../src/owner-alerts";

const BASE_URL = "https://auth.laterdog.test";
const OWNER = "owner@example.com";
const REVIEW_EMAIL = "appreview@later.dog";
const REVIEW_CODE = "31415926";
const NOW = 1_800_000_000_000;

type Sent = Parameters<OwnerAlertSender["send"]>[0];

function outbox(refuseOthersWith?: string): OwnerAlertSender & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    async send(message) {
      if (refuseOthersWith && message.to !== OWNER) throw Object.assign(new Error(`could not deliver to ${message.to}`), { code: refuseOthersWith });
      sent.push(message);
    },
  };
}

function alerting(mail: OwnerAlertSender, vars: Record<string, string> = {}): Env {
  return { ...env, ALERT_EMAIL: OWNER, EMAIL: mail, ...vars } as unknown as Env;
}

function homesThat(open: () => Promise<HomeSummary>): HomesService {
  return { open, summary: async () => null, pair: async () => ({ ok: false, summary: null }), remove: async () => ({ removed: 0 }) };
}

async function post(worker: ReturnType<typeof createWorker>, target: Env, path: string, body: unknown, token?: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.60", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), target, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function signInReviewer(worker: ReturnType<typeof createWorker>, target: Env): Promise<{ token: string; accountId: string }> {
  expect((await post(worker, target, "/api/auth/email-otp/send-verification-otp", { email: REVIEW_EMAIL, type: "sign-in" })).status).toBe(200);
  const signedIn = await post(worker, target, "/api/auth/sign-in/email-otp", { email: REVIEW_EMAIL, otp: REVIEW_CODE });
  expect(signedIn.status).toBe(200);
  const body = await signedIn.json<{ user: { id: string } }>();
  return { token: signedIn.headers.get("set-auth-token") ?? "", accountId: body.user.id };
}

describe("emailing the owner when a sign-in step breaks", () => {
  it("emails the first time each problem happens, then stays quiet about it for the hour", async () => {
    const mail = outbox();
    const owned = alerting(mail);
    expect(await alertOwner(owned, ownerAlerts.homeStartFailed(NOW))).toBe(true);
    expect(await alertOwner(owned, ownerAlerts.homeStartFailed(NOW + 1))).toBe(false);
    expect(await alertOwner(owned, ownerAlerts.signUpsCapped(NOW))).toBe(true);
    expect(mail.sent.map(({ to, subject }) => [to, subject])).toEqual([
      [OWNER, "later.dog: a Cloud home didn't start"],
      [OWNER, "later.dog: today's new sign-ups are used up"],
    ]);
    expect(mail.sent[0]!.text).toContain("at most one of these an hour");
  });

  it("sends nothing without a real ALERT_EMAIL, and a failed alert only gets logged", async () => {
    const mail = outbox();
    expect(await alertOwner({ ...env, EMAIL: mail } as unknown as Env, ownerAlerts.homeStartFailed())).toBe(false);
    expect(await alertOwner(alerting(mail, { ALERT_EMAIL: "not an address" }), ownerAlerts.homeStartFailed())).toBe(false);
    expect(mail.sent).toEqual([]);
    const down: OwnerAlertSender = { send: async () => { throw new Error("email is down"); } };
    expect(await alertOwner(alerting(down), ownerAlerts.homeStartFailed())).toBe(false);
  });

  it("says which step failed without naming the person who hit it", () => {
    expect(emailServiceCode(Object.assign(new Error("failed"), { code: "E_DELIVERY_FAILED" }))).toBe("E_DELIVERY_FAILED");
    expect(emailServiceCode(new Error("could not deliver to ada@example.com"))).toBe("no error code");
    expect(routeLabel(new Request(`${BASE_URL}/v1/installations/inst_0123456789abcdef/credentials/rotate`, { method: "POST" })))
      .toBe("POST /v1/installations/:id/credentials/rotate");
  });

  it("tells the owner when a sign-in code email fails, while the person still gets the usual answer", async () => {
    const mail = outbox("E_DELIVERY_FAILED");
    const response = await post(createWorker(fetch), alerting(mail), "/api/auth/email-otp/send-verification-otp", { email: "ada@example.com", type: "sign-in" });
    expect(response.status).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: OWNER, subject: "later.dog: sign-in codes aren't sending" });
    expect(mail.sent[0]!.text).toContain("E_DELIVERY_FAILED");
    expect(mail.sent[0]!.text).not.toContain("ada@example.com");
  });

  it("tells the owner once when new addresses hit the day's cap", async () => {
    const mail = outbox();
    const capped = alerting(mail, { NEW_EMAIL_CODES_PER_DAY: "0" });
    const worker = createWorker(fetch);
    expect((await post(worker, capped, "/api/auth/email-otp/send-verification-otp", { email: "grace@example.com", type: "sign-in" })).status).toBe(429);
    expect((await post(worker, capped, "/api/auth/email-otp/send-verification-otp", { email: "lin@example.com", type: "sign-in" })).status).toBe(429);
    expect(mail.sent.map(({ subject }) => subject)).toEqual(["later.dog: today's new sign-ups are used up"]);
  });

  it("tells the owner when someone goes on the waitlist because the Cloud homes are full", async () => {
    const mail = outbox();
    const full = alerting(mail, { CLOUD_HOME_CAP: "1" });
    const people = [];
    for (const email of ["ada@example.com", "grace@example.com"]) {
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
        .bind(id, email.split("@")[0], email, new Date(NOW).toISOString(), new Date(NOW).toISOString()).run();
      people.push(id);
    }
    expect(await homeAllowed(full, people[0]!, NOW)).toBe(true);
    expect(mail.sent).toEqual([]);
    expect(await homeAllowed(full, people[1]!, NOW + 1)).toBe(false);
    expect(mail.sent.map(({ subject }) => subject)).toEqual(["later.dog: Cloud homes are full"]);
  });

  it("tells the owner when a Cloud home fails to start right after its owner signs in", async () => {
    const mail = outbox();
    const owned = alerting(mail);
    const { accountId } = await signInReviewer(createWorker(fetch), owned);
    await env.DB.prepare("INSERT INTO cloud_homes (account_id, created_at, used_at) VALUES (?, ?, ?)").bind(accountId, NOW, NOW).run();
    expect(mail.sent).toEqual([]);
    await signInReviewer(createWorker(fetch, () => homesThat(async () => { throw new Error("no container"); })), owned);
    expect(mail.sent.map(({ subject }) => subject)).toEqual(["later.dog: a Cloud home didn't start"]);
  });

  it("tells the owner when the phone finds its Cloud home failed", async () => {
    const mail = outbox();
    const owned = alerting(mail);
    const { token } = await signInReviewer(createWorker(fetch), owned);
    const failed = createWorker(fetch, () => homesThat(async () => ({ state: "failed", origin: "https://h0-home.later.dog" })));
    const response = await post(failed, owned, "/api/cloud/home", {}, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cloud: { state: "failed" } });
    expect(mail.sent.map(({ subject }) => subject)).toEqual(["later.dog: a Cloud home didn't start"]);
  });

  it("tells the owner when sign-in or a Cloud home answers with a server error, and not for anything else", async () => {
    const mail = outbox();
    const owned = alerting(mail);
    const { token } = await signInReviewer(createWorker(fetch), owned);
    const broken = createWorker(fetch, () => homesThat(async () => { throw new Error("home service down"); }));
    expect((await post(broken, owned, "/api/cloud/home", {}, token)).status).toBe(500);
    expect(mail.sent.map(({ subject }) => subject)).toEqual(["later.dog: sign-in answered with an error"]);
    expect(mail.sent[0]!.text).toContain("answered 500 to POST /api/cloud/home");

    const codePath = new Request(`${BASE_URL}/api/auth/email-otp/send-verification-otp`, { method: "POST" });
    expect(await serverErrorAlert(codePath, errorResponse(503, "email_unavailable"))).toBeNull();
    expect(await serverErrorAlert(new Request(`${BASE_URL}/v1/installations`), errorResponse(500, "internal_error"))).toBeNull();
    expect(await serverErrorAlert(new Request(`${BASE_URL}/api/cloud/home`, { method: "POST" }), errorResponse(404, "not_found"))).toBeNull();
    expect(await serverErrorAlert(new Request(`${BASE_URL}/api/auth/sign-in/email-otp`, { method: "POST" }), errorResponse(500, "internal_error")))
      .toMatchObject({ kind: "server_error" });
  });
});
