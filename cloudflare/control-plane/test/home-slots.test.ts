import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { homeAllowed, type HomeState, type HomesService, type HomeSummary } from "../src/cloud";
import { readConfig } from "../src/config";
import { DEFAULT_UNUSED_HOME_DAYS, markHomeUsed, releaseUnusedHomes, unusedHomeDays } from "../src/home-slots";
import { createWorker } from "../src/index";

const BASE_URL = "https://auth.laterdog.test";
const DAY_MS = 24 * 60 * 60 * 1_000;

function withVars(vars: Record<string, string>): Env {
  return { ...env, ...vars } as unknown as Env;
}

function fakeHomes() {
  const homes = new Map<string, { state: HomeState; origin: string }>();
  const removed: string[] = [];
  const summary = (accountId: string): HomeSummary | null => {
    const home = homes.get(accountId);
    return home ? { ...home } : null;
  };
  const service: HomesService = {
    async open(accountId) {
      if (!homes.has(accountId)) homes.set(accountId, { state: "ready", origin: "https://h000000000000000000000000-home.later.dog" });
      return summary(accountId) as HomeSummary;
    },
    async summary(accountId) {
      return summary(accountId);
    },
    async pair(accountId, input) {
      const home = homes.get(accountId);
      if (!home) return { ok: false, summary: null };
      return { ok: true, origin: home.origin, code: "ABCD-EFGH-JKLM", credential: "laterdog_pair_0123456789abcdefghij", expiresAt: Date.now() + input.ttlSeconds * 1000 };
    },
    async remove(accountId) {
      homes.delete(accountId);
      removed.push(accountId);
      return { removed: 1 };
    },
  };
  return { service, homes, removed };
}

function harness(vars: Record<string, string> = {}) {
  const homes = fakeHomes();
  const worker = createWorker(fetch, () => homes.service);
  const workerEnv = withVars({ MANAGED_ENDPOINTS: "off", ...vars });
  async function call(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.90" });
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }), workerEnv, ctx);
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
    const token = response.headers.get("set-auth-token");
    if (!token) throw new Error("no bearer");
    return { token, userId: (await response.json<{ user: { id: string } }>()).user.id };
  }
  async function tick() {
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController(), workerEnv, ctx);
    await waitOnExecutionContext(ctx);
  }
  return { homes, call, signIn, tick, workerEnv };
}

async function slot(accountId: string) {
  return env.DB.prepare("SELECT created_at, used_at, released_at FROM cloud_homes WHERE account_id = ?")
    .bind(accountId).first<{ created_at: number; used_at: number | null; released_at: number | null }>();
}

async function age(accountId: string, days: number) {
  await env.DB.prepare("UPDATE cloud_homes SET created_at = ? WHERE account_id = ?").bind(Date.now() - days * DAY_MS, accountId).run();
}

describe("home slots go to people who use them", () => {
  it("reads how many days an unused home keeps its slot", () => {
    expect(unusedHomeDays(env)).toBe(7);
    expect(unusedHomeDays(withVars({ CLOUD_HOME_UNUSED_DAYS: "" }))).toBe(DEFAULT_UNUSED_HOME_DAYS);
    expect(unusedHomeDays(withVars({ CLOUD_HOME_UNUSED_DAYS: "0" }))).toBe(0);
    expect(unusedHomeDays(withVars({ CLOUD_HOME_UNUSED_DAYS: "3" }))).toBe(3);
    expect(unusedHomeDays(withVars({ CLOUD_HOME_UNUSED_DAYS: "9999" }))).toBe(DEFAULT_UNUSED_HOME_DAYS);
  });

  it("counts a home as used once a phone pairs with it, and never releases it", async () => {
    const { call, signIn, tick } = harness();
    const ada = await signIn("ada@example.com");
    expect((await call("/api/cloud/home", { method: "POST", token: ada.token, body: {} })).status).toBe(200);
    expect((await slot(ada.userId))?.used_at).toBeNull();
    expect((await call("/api/cloud/pairing", { method: "POST", token: ada.token, body: {} })).status).toBe(200);
    const used = await slot(ada.userId);
    expect(used?.used_at).toEqual(expect.any(Number));
    await age(ada.userId, 30);
    await tick();
    expect((await slot(ada.userId))?.released_at).toBeNull();
  });

  it("releases a slot that was never used after the set days, keeps the home's data, and gives the slot to the next person", async () => {
    const { call, signIn, tick, homes } = harness({ CLOUD_HOME_CAP: "1" });
    const idle = await signIn("idle@example.com");
    const opened = await call("/api/cloud/home", { method: "POST", token: idle.token, body: {} });
    await expect(opened.json()).resolves.toMatchObject({ entitlement: { status: "active" } });
    const next = await signIn("next@example.com");
    const full = await call("/api/cloud/home", { method: "POST", token: next.token, body: {} });
    await expect(full.json()).resolves.toMatchObject({ entitlement: { status: "inactive" }, cloud: null });

    await age(idle.userId, 6);
    await tick();
    expect((await slot(idle.userId))?.released_at).toBeNull();

    await age(idle.userId, 8);
    await tick();
    expect((await slot(idle.userId))?.released_at).toEqual(expect.any(Number));
    expect(homes.removed).toEqual([]);
    expect(homes.homes.has(idle.userId)).toBe(true);

    const room = await call("/api/cloud/home", { method: "POST", token: next.token, body: {} });
    await expect(room.json()).resolves.toMatchObject({ entitlement: { status: "active" } });
    const back = await call("/api/cloud/home", { method: "POST", token: idle.token, body: {} });
    await expect(back.json()).resolves.toMatchObject({ entitlement: { status: "inactive" }, cloud: null });
    const waiting = await env.DB.prepare("SELECT account_id FROM cloud_waitlist WHERE account_id = ?").bind(idle.userId).first();
    expect(waiting).not.toBeNull();
  });

  it("gives a released home back to its owner with fresh days when there is room", async () => {
    const accountId = crypto.randomUUID();
    const at = new Date().toISOString();
    await env.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
      .bind(accountId, "lin", "lin@example.com", at, at).run();
    const now = Date.now();
    expect(await homeAllowed(env, accountId, now - 10 * DAY_MS)).toBe(true);
    expect(await releaseUnusedHomes(env, now)).toBe(1);
    expect(await markHomeUsed(env, accountId, now)).toBe(false);
    expect(await homeAllowed(env, accountId, now)).toBe(true);
    expect(await slot(accountId)).toEqual({ created_at: now, used_at: null, released_at: null });
  });

  it("releases nothing when the days are set to zero", async () => {
    const { signIn, call, tick } = harness({ CLOUD_HOME_UNUSED_DAYS: "0" });
    const ada = await signIn("zero@example.com");
    await call("/api/cloud/home", { method: "POST", token: ada.token, body: {} });
    await age(ada.userId, 400);
    await tick();
    expect((await slot(ada.userId))?.released_at).toBeNull();
  });

  it("still deletes the home's data when someone with a released slot deletes their account", async () => {
    const { call, signIn, homes } = harness();
    const ada = await signIn("leaving@example.com");
    await call("/api/cloud/home", { method: "POST", token: ada.token, body: {} });
    await age(ada.userId, 10);
    expect(await releaseUnusedHomes(env)).toBe(1);
    expect((await call("/api/cloud/account", { method: "DELETE", token: ada.token })).status).toBe(200);
    expect(homes.removed).toEqual([ada.userId]);
  });

  it("marks every home that existed before this change as used", async () => {
    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0012_"));
    expect(migration?.queries.some((query) => /UPDATE cloud_homes SET used_at = created_at WHERE used_at IS NULL/.test(query))).toBe(true);
  });
});
