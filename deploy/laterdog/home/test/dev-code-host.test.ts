import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateBucket } from "../src/state.ts";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { FakeNamespace, resetWorld } = await import("./fake-containers.ts");
const { CloudHomeHost, CloudHomeHostLarge } = await import("../src/host.ts");
const { HomesApi } = await import("../src/index.ts");
const { homeIdentity } = await import("../src/identity.ts");
const { STATE_HOST } = await import("../src/state.ts");

const OWNER = "7eaec07f-4e74-4682-81c2-d3bf10549606";
const SOMEONE = "0b6f3c1e-2d4a-4f5b-8c7d-9e0f1a2b3c4d";
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

function cloud(devCode: string) {
  const HOMES = new FakeNamespace<Host>("HOMES");
  const HOMES_LARGE = new FakeNamespace<Host>("HOMES_LARGE");
  const env = {
    HOME_SECRET: SECRET, HOME_HOST_SUFFIX: SUFFIX, ADMIN_ORIGIN: "https://accounts.later.dog", INCLUDED_API: "https://cloud.later.dog/v1",
    LARGE_HOME_ACCOUNTS: "", DEV_CODE: devCode, HOMES, HOMES_LARGE, STATE: emptyBucket(),
    COMPUTERS: { fetch: async () => Response.json({ trial: { state: "active" }, home: true }, { status: 201 }) },
    ACCOUNTS: {},
  };
  HOMES.bind((ctx) => new CloudHomeHost(ctx as never, env as never));
  HOMES_LARGE.bind((ctx) => new CloudHomeHostLarge(ctx as never, env as never));
  const settle = async () => { for (let round = 0; round < 5; round += 1) await HOMES.settle(); };
  return { HOMES, env, settle, api: new HomesApi({} as never, env as never) };
}

async function homeOf(world: ReturnType<typeof cloud>, account: string) {
  await world.api.open(account);
  await world.settle();
  const machineId = (await homeIdentity(SECRET, account, SUFFIX)).machineId;
  const key = world.HOMES.idFromName(machineId).toString();
  return { home: world.HOMES.get(world.HOMES.idFromName(machineId)) as Routed, ctx: world.HOMES.contexts.get(key)! };
}

async function afterDeploy(world: ReturnType<typeof cloud>, ctx: unknown, devCode: string) {
  const reloaded = new CloudHomeHost(ctx as never, { ...world.env, DEV_CODE: devCode } as never) as Routed;
  await world.settle();
  return reloaded;
}

beforeEach(() => resetWorld());
afterEach(() => vi.restoreAllMocks());

describe("server code pushed from later.dog Dev reaching a home made before the switch", () => {
  it("routes an existing owner's home to pushed code once a deploy lists the owner, and the container is told to look", async () => {
    const world = cloud("");
    const { home, ctx } = await homeOf(world, OWNER);
    const before = home.outbound[STATE_HOST]!;
    expect(before.params).not.toHaveProperty("devCode");
    expect(home.envVars).not.toHaveProperty("LATERDOG_DEV_CODE");

    const reloaded = await afterDeploy(world, ctx, OWNER);
    expect(reloaded.outbound[STATE_HOST]).toEqual({ method: "state", params: { ...before.params, devCode: true } });
    expect(reloaded.envVars.LATERDOG_DEV_CODE).toBe("1");
  });

  it("rewrites the route only when the switch changes, and turns it back off", async () => {
    const world = cloud(OWNER);
    const { home, ctx } = await homeOf(world, OWNER);
    expect(home.outbound[STATE_HOST]!.params).toMatchObject({ devCode: true });

    const again = await afterDeploy(world, ctx, OWNER);
    expect(again.outbound[STATE_HOST]).toBeUndefined();

    const off = await afterDeploy(world, ctx, "");
    expect(off.outbound[STATE_HOST]!.params).not.toHaveProperty("devCode");
    expect(off.envVars).not.toHaveProperty("LATERDOG_DEV_CODE");
  });

  it("never routes anyone else's home to pushed code", async () => {
    const world = cloud(OWNER);
    const { home, ctx } = await homeOf(world, SOMEONE);
    expect(home.outbound[STATE_HOST]!.params).not.toHaveProperty("devCode");
    const reloaded = await afterDeploy(world, ctx, OWNER);
    expect(reloaded.outbound[STATE_HOST]).toBeUndefined();
    expect(reloaded.envVars).not.toHaveProperty("LATERDOG_DEV_CODE");
  });
});
