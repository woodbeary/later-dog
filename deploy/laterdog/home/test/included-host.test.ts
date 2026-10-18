import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateBucket } from "../src/state.ts";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { FakeNamespace, resetWorld } = await import("./fake-containers.ts");
const { CloudHomeHost, CloudHomeHostLarge } = await import("../src/host.ts");
const { HomesApi } = await import("../src/index.ts");
const { homeIdentity } = await import("../src/identity.ts");
const { INCLUDED_RENEW_MS } = await import("../src/included.ts");

const OWNER = "owner-account";
const SECRET = "test-home-secret";
const SUFFIX = "-home.later.dog";
const T0 = Date.UTC(2026, 9, 18, 12);

type Host = InstanceType<typeof CloudHomeHost>;

function emptyBucket(): StateBucket {
  return {
    head: async () => null,
    get: async () => null,
    put: async () => ({}),
    delete: async () => undefined,
    list: async () => ({ objects: [], truncated: false }),
  };
}

function cloud(homeAnswers = true) {
  const HOMES = new FakeNamespace<Host>("HOMES");
  const HOMES_LARGE = new FakeNamespace<Host>("HOMES_LARGE");
  const claims: string[] = [];
  const answers: number[] = [];
  const env = {
    HOME_SECRET: SECRET,
    HOME_HOST_SUFFIX: SUFFIX,
    ADMIN_ORIGIN: "https://accounts.later.dog",
    INCLUDED_API: "https://cloud.later.dog/v1",
    LARGE_HOME_ACCOUNTS: "",
    HOMES,
    HOMES_LARGE,
    STATE: emptyBucket(),
    COMPUTERS: {
      fetch: async (request: Request) => {
        claims.push(((await request.json()) as { claim: string }).claim);
        const status = answers.shift() ?? 201;
        return Response.json(status < 300 ? { trial: { state: "active" }, ...(homeAnswers ? { home: true } : {}) } : { error: { code: "busy" } }, { status });
      },
    },
    ACCOUNTS: {},
  };
  HOMES.bind((ctx) => new CloudHomeHost(ctx as never, env as never));
  HOMES_LARGE.bind((ctx) => new CloudHomeHostLarge(ctx as never, env as never));
  const settle = async () => {
    for (let round = 0; round < 5; round += 1) await HOMES.settle();
  };
  return { HOMES, claims, answers, api: new HomesApi({} as never, env as never), settle };
}

async function opened(homeAnswers = true) {
  const world = cloud(homeAnswers);
  await world.api.open(OWNER);
  await world.settle();
  const machineId = (await homeIdentity(SECRET, OWNER, SUFFIX)).machineId;
  const home = world.HOMES.get(world.HOMES.idFromName(machineId));
  return { ...world, home };
}

let now = T0;
beforeEach(() => {
  resetWorld();
  now = T0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a home's included later.dog key", () => {
  it("renews the same key before its grant runs out, so the running home keeps working without a restart", async () => {
    const { home, claims, HOMES, settle } = await opened();
    expect(claims).toHaveLength(1);
    const key = home.envVars.LATERDOG_INCLUDED_KEY;
    expect(key).toMatch(/^ldt_[A-Za-z0-9_-]{43}$/);
    const starts = HOMES.machine((await homeIdentity(SECRET, OWNER, SUFFIX)).machineId).starts;

    now = T0 + INCLUDED_RENEW_MS - 1;
    await home.maintain();
    expect(claims).toHaveLength(1);

    now = T0 + INCLUDED_RENEW_MS;
    await home.maintain();
    await settle();
    expect(claims).toEqual([claims[0], claims[0]]);
    expect(home.envVars.LATERDOG_INCLUDED_KEY).toBe(key);
    expect(HOMES.machine((await homeIdentity(SECRET, OWNER, SUFFIX)).machineId).starts).toBe(starts);
  });

  it("asks again with the same key until the computers service has made it a home's grant", async () => {
    const { home, claims } = await opened(false);
    const key = home.envVars.LATERDOG_INCLUDED_KEY;
    const asked = claims.length;
    now = T0 + 6 * 60 * 60_000;
    await home.maintain();
    expect(claims.length).toBe(asked + 1);
    expect(new Set(claims)).toEqual(new Set([claims[0]]));
    expect(home.envVars.LATERDOG_INCLUDED_KEY).toBe(key);
  });

  it("tries the renewal again later when the computers service does not answer", async () => {
    const { home, claims, answers } = await opened();
    const key = home.envVars.LATERDOG_INCLUDED_KEY;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    now = T0 + INCLUDED_RENEW_MS;
    answers.push(503);
    await home.maintain();
    await home.maintain();
    expect(claims).toEqual([claims[0], claims[0], claims[0]]);
    expect(home.envVars.LATERDOG_INCLUDED_KEY).toBe(key);

    now += 1;
    await home.maintain();
    expect(claims).toHaveLength(3);
  });
});
