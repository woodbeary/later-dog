import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateBucket } from "../src/state.ts";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { FakeNamespace, FakeStorage, fakeContext, resetWorld } = await import("./fake-containers.ts");
const { CloudHomeHost, CloudHomeHostLarge } = await import("../src/host.ts");
const { HomesApi } = await import("../src/index.ts");
const { homeIdentity } = await import("../src/identity.ts");
const { GOOGLE_HOST } = await import("../src/google.ts");

const OWNER = "7eaec07f-4e74-4682-81c2-d3bf10549606";
const SECRET = "test-home-secret";
const SUFFIX = "-home.later.dog";

type Host = InstanceType<typeof CloudHomeHost>;
type Routed = Host & { outbound: Record<string, { method: string; params?: Record<string, unknown> }> };

function emptyBucket(): StateBucket {
  return {
    head: async () => null,
    get: async () => null,
    put: async () => ({}),
    delete: async () => undefined,
    list: async () => ({ objects: [], truncated: false }),
  };
}

function cloud(accounts: Record<string, unknown> = {}) {
  const HOMES = new FakeNamespace<Host>("HOMES");
  const HOMES_LARGE = new FakeNamespace<Host>("HOMES_LARGE");
  const env = {
    HOME_SECRET: SECRET, HOME_HOST_SUFFIX: SUFFIX, ADMIN_ORIGIN: "https://accounts.later.dog", INCLUDED_API: "https://cloud.later.dog/v1",
    LARGE_HOME_ACCOUNTS: "", DEV_CODE: "", HOMES, HOMES_LARGE, STATE: emptyBucket(),
    COMPUTERS: { fetch: async () => Response.json({ trial: { state: "active" }, home: true }, { status: 201 }) },
    ACCOUNTS: accounts,
  };
  HOMES.bind((ctx) => new CloudHomeHost(ctx as never, env as never));
  HOMES_LARGE.bind((ctx) => new CloudHomeHostLarge(ctx as never, env as never));
  const settle = async () => { for (let round = 0; round < 5; round += 1) await HOMES.settle(); };
  return { HOMES, env, settle, api: new HomesApi({} as never, env as never) };
}

async function storedRecord(storage: InstanceType<typeof FakeStorage>) {
  return (await storage.get<Record<string, unknown>>("home"))!;
}

async function construct(world: ReturnType<typeof cloud>, storage: InstanceType<typeof FakeStorage>, machineId: string) {
  const ctx = fakeContext(world.HOMES.idFromName(machineId), storage);
  const home = new CloudHomeHost(ctx as never, world.env as never) as Routed;
  await Promise.all(ctx.pending);
  return home;
}

beforeEach(() => resetWorld());
afterEach(() => vi.restoreAllMocks());

describe("the Google route in front of a home", () => {
  it("gives a new home its own Google token, route and settings", async () => {
    const world = cloud();
    await world.api.open(OWNER);
    await world.settle();
    const { machineId } = await homeIdentity(SECRET, OWNER, SUFFIX);
    const key = world.HOMES.idFromName(machineId).toString();
    const home = world.HOMES.get(world.HOMES.idFromName(machineId)) as Routed;
    const record = await storedRecord(world.HOMES.contexts.get(key)!.storage);
    expect(record.googleToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.googleToken).not.toBe(record.emailToken);
    expect(record.googleToken).not.toBe(record.stateToken);
    expect(home.outbound[GOOGLE_HOST]).toEqual({ method: "google", params: { token: record.googleToken, accountId: OWNER } });
    expect(home.envVars.LATERDOG_CLOUD_GOOGLE_URL).toBe("http://google.internal");
    expect(home.envVars.LATERDOG_CLOUD_GOOGLE_TOKEN).toBe(record.googleToken);
  });

  it("gives a home adopted before this change a token once, and keeps it", async () => {
    const world = cloud();
    const identity = await homeIdentity(SECRET, OWNER, SUFFIX);
    const storage = new FakeStorage();
    await storage.put("home", { ...identity, createdAt: 1, stateToken: "s".repeat(43), emailToken: "e".repeat(43), readyAt: 2 });
    await storage.put("state-route-dev-code", false);

    const first = await construct(world, storage, identity.machineId);
    const token = (await storedRecord(storage)).googleToken as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.outbound[GOOGLE_HOST]).toEqual({ method: "google", params: { token, accountId: OWNER } });
    expect(first.envVars.LATERDOG_CLOUD_GOOGLE_TOKEN).toBe(token);
    expect(await storedRecord(storage)).toMatchObject({ emailToken: "e".repeat(43), stateToken: "s".repeat(43), readyAt: 2 });

    const second = await construct(world, storage, identity.machineId);
    expect((await storedRecord(storage)).googleToken).toBe(token);
    expect(second.outbound[GOOGLE_HOST]).toBeUndefined();
    expect(second.envVars.LATERDOG_CLOUD_GOOGLE_TOKEN).toBe(token);

    const third = await construct(world, storage, identity.machineId);
    expect(third.outbound[GOOGLE_HOST]).toBeUndefined();
    expect(third.envVars.LATERDOG_CLOUD_GOOGLE_TOKEN).toBe(token);
  });

  it("registers the route again with the same token when the route was never written", async () => {
    const world = cloud();
    const identity = await homeIdentity(SECRET, OWNER, SUFFIX);
    const storage = new FakeStorage();
    await storage.put("home", { ...identity, createdAt: 1, stateToken: "s".repeat(43), emailToken: "e".repeat(43), googleToken: "g".repeat(43) });
    const home = await construct(world, storage, identity.machineId);
    expect(home.outbound[GOOGLE_HOST]).toEqual({ method: "google", params: { token: "g".repeat(43), accountId: OWNER } });
    expect((await storedRecord(storage)).googleToken).toBe("g".repeat(43));
  });

  it("answers the home's own requests through the registered route, for its own account only", async () => {
    const asked: string[] = [];
    const world = cloud({ googleToken: async (accountId: string) => { asked.push(accountId); return { ok: true, token: { access_token: "a", expires_in: 1, scope: "s" } }; } });
    await world.api.open(OWNER);
    await world.settle();
    const { machineId } = await homeIdentity(SECRET, OWNER, SUFFIX);
    const home = world.HOMES.get(world.HOMES.idFromName(machineId)) as Routed;
    const route = home.outbound[GOOGLE_HOST]!;
    const handler = (CloudHomeHost.outboundHandlers as Record<string, Function>)[route.method]!;
    const ask = (token: string) => new Request("http://google.internal/token", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ grant: "refresh", refreshToken: "r" }) });
    const answered = await handler(ask(home.envVars.LATERDOG_CLOUD_GOOGLE_TOKEN!), world.env, { params: route.params }) as Response;
    expect(answered.status).toBe(200);
    expect(asked).toEqual([OWNER]);
    const refused = await handler(ask(home.envVars.LATERDOG_CLOUD_EMAIL_TOKEN!), world.env, { params: route.params }) as Response;
    expect(refused.status).toBe(401);
    const older = await handler(ask(home.envVars.LATERDOG_CLOUD_GOOGLE_TOKEN!), { ...world.env, ACCOUNTS: {} }, { params: route.params }) as Response;
    expect(older.status).toBe(503);
  });
});
