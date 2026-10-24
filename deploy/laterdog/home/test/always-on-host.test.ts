import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { FakeNamespace, resetWorld } = await import("./fake-containers.ts");
const { CloudHomeHost, CloudHomeHostLarge } = await import("../src/host.ts");
const { HomesApi } = await import("../src/index.ts");
const { homeIdentity } = await import("../src/identity.ts");

const OWNER = "7eaec07f-4e74-4682-81c2-d3bf10549606";
const SECRET = "test-home-secret";
const SUFFIX = "-home.later.dog";

type Host = InstanceType<typeof CloudHomeHost>;

async function home(alwaysOnAccounts: string) {
  const HOMES = new FakeNamespace<Host>("HOMES");
  const HOMES_LARGE = new FakeNamespace<Host>("HOMES_LARGE");
  const env: Record<string, unknown> = {
    HOME_SECRET: SECRET, HOME_HOST_SUFFIX: SUFFIX, ADMIN_ORIGIN: "https://accounts.later.dog", INCLUDED_API: "https://cloud.later.dog/v1",
    LARGE_HOME_ACCOUNTS: "", ALWAYS_ON_ACCOUNTS: alwaysOnAccounts, HOMES, HOMES_LARGE, STATE: {},
    COMPUTERS: { fetch: async () => Response.json({ trial: { state: "active" } }, { status: 201 }) }, ACCOUNTS: {},
  };
  HOMES.bind((ctx) => new CloudHomeHost(ctx as never, env as never));
  HOMES_LARGE.bind((ctx) => new CloudHomeHostLarge(ctx as never, env as never));
  const api = new HomesApi({} as never, env as never);
  await api.open(OWNER);
  await HOMES.settle();
  const machineId = (await homeIdentity(SECRET, OWNER, SUFFIX)).machineId;
  const host = HOMES.get(HOMES.idFromName(machineId)) as unknown as Host & { schedules: Map<string, number>; keepUp(): Promise<void>; onStop(stop: { exitCode: number; reason: string }): void };
  return { host, machine: HOMES.machine(machineId), settle: () => HOMES.settle() };
}

beforeEach(() => {
  resetWorld();
});

describe("an always-on home whose computer stops", () => {
  it("asks to be brought back within seconds, and comes back when asked", async () => {
    const h = await home(OWNER);
    await h.host.keepUp();
    await h.settle();
    expect(h.machine.running).toBe(true);
    const starts = h.machine.starts;
    const asked = h.host.schedules.get("keepUp") ?? 0;
    h.machine.running = false;
    h.host.onStop({ exitCode: 0, reason: "a new version rolled out" });
    await h.settle();
    expect(h.host.schedules.get("keepUp")).toBe(asked + 1);
    await h.host.keepUp();
    await h.settle();
    expect(h.machine.running).toBe(true);
    expect(h.machine.starts).toBe(starts + 1);
  });

  it("stays down when its account is not always on", async () => {
    const h = await home("");
    const asked = h.host.schedules.get("keepUp") ?? 0;
    h.host.onStop({ exitCode: 0, reason: "slept" });
    await h.settle();
    expect(h.host.schedules.get("keepUp") ?? 0).toBe(asked);
  });
});
