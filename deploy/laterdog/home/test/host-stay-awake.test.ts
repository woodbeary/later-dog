import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { FakeNamespace, resetWorld } = await import("./fake-containers.ts");
const { CloudHomeHost, PERSON_SLEEP_AFTER, ROUTINE_SLEEP_AFTER } = await import("../src/host.ts");
const { default: worker, HomesApi } = await import("../src/index.ts");
const { homeIdentity } = await import("../src/identity.ts");
const { LENDING_HEADER } = await import("../src/waking.ts");
const { HOLD_STEP_MS, HOLD_SLEEP_AFTER, PERSON_WAKE_EARLY_MS, WORK_STRETCH_MS } = await import("../src/stay-awake.ts");
const { WAKE_EARLY_MS } = await import("../src/activity.ts");

const OWNER = "owner-account";
const SECRET = "test-home-secret";
const SUFFIX = "-home.later.dog";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = 1_800_000_000_000 - 8 * HOUR + 22 * HOUR;

type Host = InstanceType<typeof CloudHomeHost>;

async function openHome() {
  const HOMES = new FakeNamespace<Host>("HOMES");
  const HOMES_LARGE = new FakeNamespace<Host>("HOMES_LARGE");
  const env = {
    HOME_SECRET: SECRET,
    HOME_HOST_SUFFIX: SUFFIX,
    ADMIN_ORIGIN: "https://accounts.later.dog",
    INCLUDED_API: "https://cloud.later.dog/v1",
    LARGE_HOME_ACCOUNTS: "",
    HOMES,
    HOMES_LARGE,
    STATE: {},
    COMPUTERS: { fetch: async () => new Response("{}") },
    ACCOUNTS: {},
  };
  HOMES.bind((ctx) => new CloudHomeHost(ctx as never, env as never));
  HOMES_LARGE.bind((ctx) => new CloudHomeHost(ctx as never, env as never));
  await new HomesApi({} as never, env as never).open(OWNER);
  await HOMES.settle();
  const machineId = (await homeIdentity(SECRET, OWNER, SUFFIX)).machineId;
  const id = HOMES.idFromName(machineId);
  const host = HOMES.get(id);
  const ctx = HOMES.contexts.get(id.toString())!;
  const visit = async (headers: Record<string, string> = {}) => {
    await worker.fetch(new Request(`https://${machineId}${SUFFIX}/api/bots`, { headers: { accept: "application/json", ...headers } }), env as never);
    await HOMES.settle();
  };
  const restart = async () => {
    const again = new CloudHomeHost(ctx as never, env as never);
    await HOMES.settle();
    return again;
  };
  return { host, machine: ctx.machine, storage: ctx.storage, visit, restart, settle: () => HOMES.settle() };
}

function at(time: number): void {
  vi.setSystemTime(time);
}

beforeEach(() => {
  resetWorld();
  vi.useFakeTimers({ toFake: ["Date"] });
  at(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a home that keeps itself awake for its dogs", () => {
  it("checks back every ten minutes while the home names work, then sleeps and wakes for the next routine", async () => {
    const { host, machine } = await openHome();
    machine.activity = { busy: true, nextAt: null, work: ["turn"] };
    await host.onActivityExpired();
    expect(machine.signals).toBe(0);
    expect(host.sleepAfter).toBe(HOLD_SLEEP_AFTER);

    const routineAt = START + 3 * HOUR;
    machine.activity = { busy: false, nextAt: routineAt, work: [] };
    at(START + HOLD_STEP_MS);
    await host.onActivityExpired();
    expect(machine.signals).toBe(1);
    expect(host.scheduledFor.get("wakeForRoutine")).toBe(routineAt - WAKE_EARLY_MS);
    expect(host.scheduledFor.has("wakeForPerson")).toBe(false);
  });

  it("sleeps with a stuck job after six hours in a row, unless the person came by in between", async () => {
    const { host, machine, visit } = await openHome();
    machine.activity = { busy: true, nextAt: null, work: ["cloud_job"] };
    for (let time = START; time < START + WORK_STRETCH_MS - 30 * MINUTE; time += HOLD_STEP_MS) {
      at(time);
      await host.onActivityExpired();
    }
    expect(machine.signals).toBe(0);
    await visit();
    expect(host.sleepAfter).toBe(PERSON_SLEEP_AFTER);
    const afterVisit = START + WORK_STRETCH_MS + 30 * MINUTE;
    at(afterVisit);
    await host.onActivityExpired();
    expect(machine.signals).toBe(0);
    at(afterVisit + WORK_STRETCH_MS - MINUTE);
    await host.onActivityExpired();
    expect(machine.signals).toBe(0);
    at(afterVisit + WORK_STRETCH_MS);
    await host.onActivityExpired();
    expect(machine.signals).toBe(1);
  });

  it("learns the person's hours from their requests, keeps them through a restart, and wakes a few minutes before them", async () => {
    const { machine, visit, restart, settle } = await openHome();
    for (const day of [1, 2, 3]) {
      at(START + day * DAY - 14 * HOUR);
      await visit();
    }
    at(START + 3 * DAY - 14 * HOUR + 10 * MINUTE);
    await visit({ [LENDING_HEADER]: "1" });
    machine.activity = { busy: false, nextAt: null, work: [] };
    const host = await restart();

    at(START + 3 * DAY);
    await host.onActivityExpired();
    expect(machine.signals).toBe(1);
    const usualStart = START + 4 * DAY - 14 * HOUR;
    expect(host.scheduledFor.get("wakeForPerson")).toBe(usualStart - PERSON_WAKE_EARLY_MS);

    machine.exit?.();
    at(usualStart - PERSON_WAKE_EARLY_MS);
    await host.wakeForPerson();
    await settle();
    expect(machine.running).toBe(true);
    expect(host.sleepAfter).toBe(ROUTINE_SLEEP_AFTER);
    await host.onActivityExpired();
    expect(machine.signals).toBe(1);
    expect(host.sleepAfter).toBe(HOLD_SLEEP_AFTER);
  });

  it("doesn't count lending requests as the person", async () => {
    const { visit, storage } = await openHome();
    await visit({ [LENDING_HEADER]: "1" });
    expect(await storage.get("rhythm")).toBeUndefined();
    await visit();
    expect(await storage.get("rhythm")).toHaveLength(1);
  });

  it("never shortens an awake home's sleep when a scheduled wake fires", async () => {
    const { host, visit } = await openHome();
    await visit();
    await host.wakeForPerson();
    await host.wakeForRoutine();
    expect(host.sleepAfter).toBe(PERSON_SLEEP_AFTER);
  });
});
