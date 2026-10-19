import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { homeAllowed, type HomesService, type HomeSummary } from "../src/cloud";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import { accountFromSignIn, warmHomeForAccount } from "../src/warm-home";

const BASE_URL = "https://auth.laterdog.test";

async function person(email: string): Promise<string> {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  await env.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
    .bind(id, email.split("@")[0], email, at, at).run();
  return id;
}

function opener() {
  const opened: string[] = [];
  const summary: HomeSummary = { state: "setting_up", origin: "https://h000000000000000000000000-home.later.dog", setup: { step: "starting" } };
  const service: HomesService = {
    async open(accountId) { opened.push(accountId); return summary; },
    async summary() { return summary; },
    async pair() { return { ok: false, summary }; },
    async remove() { return { removed: 0 }; },
  };
  return { opened, service };
}

async function post(worker: ReturnType<typeof createWorker>, path: string, body: unknown, ip: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function mintOTP(email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  return otp;
}

describe("warming a home only for its signed-in owner", () => {
  it("wakes the home of someone who already has one", async () => {
    const ada = await person("ada@example.com");
    expect(await homeAllowed(env as unknown as Env, ada)).toBe(true);
    const homes = opener();
    expect(await warmHomeForAccount(env as unknown as Env, homes.service, ada)).toBe(true);
    expect(homes.opened).toEqual([ada]);
  });

  it("never starts a home for an account with no home yet", async () => {
    const grace = await person("grace@example.com");
    const homes = opener();
    expect(await warmHomeForAccount(env as unknown as Env, homes.service, grace)).toBe(false);
    expect(await warmHomeForAccount(env as unknown as Env, homes.service, crypto.randomUUID())).toBe(false);
    expect(homes.opened).toEqual([]);
  });

  it("reads the account only from a successful sign-in", async () => {
    expect(await accountFromSignIn(Response.json({ token: "t", user: { id: "abc" } }))).toBe("abc");
    expect(await accountFromSignIn(Response.json({ user: { id: 42 } }))).toBeNull();
    expect(await accountFromSignIn(Response.json({ user: { id: "abc" } }, { status: 400 }))).toBeNull();
    expect(await accountFromSignIn(new Response("not json"))).toBeNull();
  });

  it("asking for a code with an owner's email does not wake their home", async () => {
    const ada = await person("owner@example.com");
    expect(await homeAllowed(env as unknown as Env, ada)).toBe(true);
    const homes = opener();
    const worker = createWorker(fetch, () => homes.service);
    const asked = await post(worker, "/api/auth/email-otp/send-verification-otp", { email: "owner@example.com", type: "sign-in" }, "198.51.100.61");
    expect(asked.status).toBe(200);
    expect(homes.opened).toEqual([]);
  });

  it("a wrong code does not wake the home, and signing in does", async () => {
    const ada = await person("signs-in@example.com");
    expect(await homeAllowed(env as unknown as Env, ada)).toBe(true);
    const homes = opener();
    const worker = createWorker(fetch, () => homes.service);
    const wrong = await post(worker, "/api/auth/sign-in/email-otp", { email: "signs-in@example.com", otp: "00000000", name: "Ada" }, "198.51.100.62");
    expect(wrong.status).toBe(400);
    expect(homes.opened).toEqual([]);
    const otp = await mintOTP("signs-in@example.com");
    const signedIn = await post(worker, "/api/auth/sign-in/email-otp", { email: "signs-in@example.com", otp, name: "Ada" }, "198.51.100.62");
    expect(signedIn.status).toBe(200);
    expect(homes.opened).toEqual([ada]);
  });

  it("signing in without a home starts nothing", async () => {
    const homes = opener();
    const worker = createWorker(fetch, () => homes.service);
    const otp = await mintOTP("new-person@example.com");
    const signedIn = await post(worker, "/api/auth/sign-in/email-otp", { email: "new-person@example.com", otp, name: "New" }, "198.51.100.63");
    expect(signedIn.status).toBe(200);
    expect(homes.opened).toEqual([]);
  });
});
