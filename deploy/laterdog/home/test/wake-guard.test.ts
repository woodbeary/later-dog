import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateBucket } from "../src/state.ts";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { FakeNamespace, fakeContext, resetWorld, world } = await import("./fake-containers.ts");
const { CloudHomeHost, CloudHomeHostLarge, PERSON_SLEEP_AFTER, ROUTINE_SLEEP_AFTER } = await import("../src/host.ts");
const { default: worker, HomesApi } = await import("../src/index.ts");
const { homeIdentity } = await import("../src/identity.ts");
const { WAKE_HEADER } = await import("../src/waking.ts");
const guard = await import("../src/wake-guard.ts");

const OWNER = "owner-account";
const SECRET = "test-home-secret";
const SUFFIX = "-home.later.dog";
const T0 = Date.UTC(2026, 9, 19, 12);
const OWNER_TOKEN = `laterdog_sess_${"o".repeat(43)}`;
const STRANGER_TOKEN = `laterdog_sess_${"s".repeat(43)}`;
const COOKIE = "laterdog_session_8799_abc123";
const HOOK = `/hooks/wh_github/${"k".repeat(32)}`;

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

function cloud(mode?: string) {
  const HOMES = new FakeNamespace<Host>("HOMES");
  const HOMES_LARGE = new FakeNamespace<Host>("HOMES_LARGE");
  const env: Record<string, unknown> = {
    HOME_SECRET: SECRET,
    HOME_HOST_SUFFIX: SUFFIX,
    ADMIN_ORIGIN: "https://accounts.later.dog",
    INCLUDED_API: "https://cloud.later.dog/v1",
    LARGE_HOME_ACCOUNTS: "",
    ...(mode === undefined ? {} : { HOME_WAKE_GUARD: mode }),
    HOMES,
    HOMES_LARGE,
    STATE: emptyBucket(),
    COMPUTERS: { fetch: async () => Response.json({ trial: { state: "active" } }, { status: 201 }) },
    ACCOUNTS: {},
  };
  HOMES.bind((ctx) => new CloudHomeHost(ctx as never, env as never));
  HOMES_LARGE.bind((ctx) => new CloudHomeHostLarge(ctx as never, env as never));
  const api = new HomesApi({} as never, env as never);
  const settle = async () => {
    for (let round = 0; round < 5; round += 1) {
      await HOMES.settle();
      await HOMES_LARGE.settle();
    }
  };
  return { env, HOMES, HOMES_LARGE, api, settle };
}

async function awakeHome(mode?: string) {
  const world = cloud(mode);
  await world.api.open(OWNER);
  await world.settle();
  const machineId = (await homeIdentity(SECRET, OWNER, SUFFIX)).machineId;
  const home = world.HOMES.get(world.HOMES.idFromName(machineId));
  const machine = world.HOMES.machine(machineId);
  const visit = async (path: string, init: RequestInit = {}) => {
    const response = await worker.fetch(new Request(`https://${machineId}${SUFFIX}${path}`, init), world.env as never);
    await world.settle();
    return response;
  };
  const sleep = async () => {
    await (home as unknown as { stop(): Promise<void> }).stop();
    machine.exit?.();
  };
  return { ...world, machineId, home, machine, visit, sleep };
}

const asOwner = (extra: Record<string, string> = {}) => ({ headers: { accept: "application/json", authorization: `Bearer ${OWNER_TOKEN}`, ...extra } });
const asStranger = { headers: { accept: "application/json", authorization: `Bearer ${STRANGER_TOKEN}` } };
const browserPage = { headers: { accept: "text/html,application/xhtml+xml" } };

let now = T0;
beforeEach(() => {
  resetWorld();
  now = T0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("which requests carry a credential the home Worker can check", () => {
  const at = (path: string, init: RequestInit = {}) => new Request(`https://h1-home.later.dog${path}`, init);

  it("reads a session from a bearer token or from a session cookie, and both name the same waker", async () => {
    const bearer = guard.wakeCredential(at("/api/bots", { headers: { authorization: `Bearer ${OWNER_TOKEN}` } }));
    const cookie = guard.wakeCredential(at("/", { headers: { cookie: `theme=dark; ${COOKIE}=${OWNER_TOKEN}` } }));
    expect(bearer).toEqual({ kind: "session", token: OWNER_TOKEN, via: "bearer" });
    expect(cookie).toEqual({ kind: "session", token: OWNER_TOKEN, via: "cookie", cookie: COOKIE });
    expect(await guard.wakerKey(bearer!)).toBe(await guard.wakerKey(cookie!));
    expect(await guard.wakerKey(bearer!)).not.toContain(OWNER_TOKEN);
  });

  it("reads a webhook's secret from its URL or its bearer token, only on POST", () => {
    expect(guard.wakeCredential(at(HOOK, { method: "POST" }))).toEqual({ kind: "hook", endpoint: "wh_github", secret: "k".repeat(32) });
    expect(guard.wakeCredential(at("/hooks/wh_github", { method: "POST", headers: { authorization: "Bearer hook-secret" } }))).toEqual({ kind: "hook", endpoint: "wh_github", secret: "hook-secret" });
    expect(guard.wakeCredential(at(HOOK))).toBeNull();
    expect(guard.wakeCredential(at("/hooks/wh_github", { method: "POST" }))).toBeNull();
    expect(guard.wakeCredential(at("/hooks/wh_github/%E0%A4%A", { method: "POST" }))).toBeNull();
  });

  it("finds nothing in a bare request, a stream ticket, a pairing code or a malformed token", () => {
    expect(guard.wakeCredential(at("/"))).toBeNull();
    expect(guard.wakeCredential(at("/api/events?ticket=laterdog_tick_abcdefabcdefabcdefabcdefabcdefab"))).toBeNull();
    expect(guard.wakeCredential(at("/api/auth/pair", { method: "POST", body: JSON.stringify({ code: "ABCD-EFGH-JKMN" }) }))).toBeNull();
    expect(guard.wakeCredential(at("/api/bots", { headers: { authorization: "Bearer laterdog_sess_short" } }))).toBeNull();
    expect(guard.wakeCredential(at("/api/bots", { headers: { authorization: "Bearer omc_device_token_that_is_long_enough_to_look_real" } }))).toBeNull();
    expect(guard.wakeCredential(at("/", { headers: { cookie: `session=${OWNER_TOKEN}` } }))).toBeNull();
  });

  it("enforces only when the deploy says owners", () => {
    expect(guard.wakeGuard(undefined)).toBe("learning");
    expect(guard.wakeGuard("")).toBe("learning");
    expect(guard.wakeGuard("strict")).toBe("learning");
    expect(guard.wakeGuard(" Owners ")).toBe("owners");
  });

  it("keeps the most recent wakers and forgets one unseen for a month", () => {
    let wakers: Record<string, number> = {};
    for (let index = 0; index < guard.WAKERS_KEPT + 5; index += 1) wakers = guard.remember(wakers, `k${index}`, T0 + index);
    expect(Object.keys(wakers)).toHaveLength(guard.WAKERS_KEPT);
    expect(guard.remembered(wakers, `k${guard.WAKERS_KEPT + 4}`, T0)).toBe(true);
    expect(guard.remembered(wakers, "k0", T0)).toBe(false);
    expect(guard.remembered(wakers, "k10", T0 + 10 + guard.WAKER_FORGET_MS)).toBe(false);
  });

  it("tells an owner's session from a refused one and from a home that could not answer", async () => {
    expect(await guard.sessionCheckOutcome(Response.json({ kind: "session" }))).toBe("owner");
    expect(await guard.sessionCheckOutcome(Response.json({ error: "unauthorized" }, { status: 401 }))).toBe("refused");
    expect(await guard.sessionCheckOutcome(Response.json({ error: "waking" }, { status: 503 }))).toBe("unknown");
  });
});

describe("a sleeping home, by default", () => {
  it("does not boot for an unauthenticated GET and shows the resting page", async () => {
    const { visit, sleep, machine } = await awakeHome();
    await sleep();
    const starts = machine.starts;
    const response = await visit("/", browserPage);
    expect(response.status).toBe(503);
    expect(response.headers.get(WAKE_HEADER)).toBe("asleep");
    expect(await response.text()).toContain("My Cloud is resting");
    expect(machine.running).toBe(false);
    expect(machine.starts).toBe(starts);
  });

  it("does not boot for a malformed token, a bare stream ticket or a pairing attempt with no window open", async () => {
    const { visit, sleep, machine } = await awakeHome();
    await sleep();
    const starts = machine.starts;
    await visit("/api/bots", { headers: { authorization: "Bearer nonsense" } });
    await visit("/api/events?ticket=laterdog_tick_abcdefabcdefabcdefabcdefabcdefab");
    await visit("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(machine.running).toBe(false);
    expect(machine.starts).toBe(starts);
  });

  it("boots for a request carrying an owner session", async () => {
    const { visit, sleep, machine } = await awakeHome();
    await sleep();
    const starts = machine.starts;
    const response = await visit("/api/bots", asOwner());
    expect(response.status).toBe(503);
    expect(response.headers.get(WAKE_HEADER)).toBe("waking");
    expect(machine.running).toBe(true);
    expect(machine.starts).toBe(starts + 1);
    expect(await (await visit("/api/bots", asOwner())).text()).toBe("home HOMES /api/bots");
  });

  it("boots for a browser carrying its session cookie", async () => {
    const { visit, sleep, machine } = await awakeHome();
    await sleep();
    await visit("/", { headers: { accept: "text/html", cookie: `${COOKIE}=${OWNER_TOKEN}` } });
    expect(machine.running).toBe(true);
  });
});

describe("an awake home", () => {
  it("answers a stranger without letting the request keep it awake", async () => {
    const { home, visit } = await awakeHome();
    const proxied = vi.spyOn(home as unknown as { containerFetch(request: Request): Promise<Response> }, "containerFetch");
    home.sleepAfter = ROUTINE_SLEEP_AFTER;
    const answer = await visit("/api/bots", browserPage);
    expect(await answer.text()).toBe("home HOMES /api/bots");
    expect(home.sleepAfter).toBe(ROUTINE_SLEEP_AFTER);
    expect(proxied).not.toHaveBeenCalled();

    await visit("/api/bots", asOwner());
    expect(home.sleepAfter).toBe(PERSON_SLEEP_AFTER);
    expect(proxied).toHaveBeenCalledTimes(1);
  });

  it("sleeps 30 minutes after the person's last request", () => {
    expect(PERSON_SLEEP_AFTER).toBe("30m");
  });
});

describe("a home that boots only for its owner", () => {
  it("does not boot for a well-formed session it has never seen work", async () => {
    const { visit, sleep, machine } = await awakeHome("owners");
    await sleep();
    const response = await visit("/api/bots", asStranger);
    expect(response.headers.get(WAKE_HEADER)).toBe("asleep");
    expect(machine.running).toBe(false);
  });

  it("learns a session the home accepted while awake and boots for it later", async () => {
    const { visit, sleep, machine, home } = await awakeHome("owners");
    world.sessions.add(OWNER_TOKEN);
    await visit("/api/bots", asOwner());
    expect(world.sessionChecks).toBe(1);
    expect(await home.knowsWaker(await guard.wakerKey({ kind: "session", token: OWNER_TOKEN, via: "bearer" }))).toBe(true);
    await visit("/api/bots", asOwner());
    expect(world.sessionChecks).toBe(1);

    await sleep();
    const starts = machine.starts;
    expect((await visit("/api/bots", asOwner())).headers.get(WAKE_HEADER)).toBe("waking");
    expect(machine.running).toBe(true);
    expect(machine.starts).toBe(starts + 1);
  });

  it("checks a refused session once however often it is sent, and never boots for it", async () => {
    const { visit, sleep, machine } = await awakeHome("owners");
    for (let round = 0; round < 5; round += 1) await visit("/api/bots", asStranger);
    expect(world.sessionChecks).toBe(1);
    await sleep();
    await visit("/api/bots", asStranger);
    expect(machine.running).toBe(false);
  });

  it("checks again when the home could not answer the first time", async () => {
    const { visit, home } = await awakeHome("owners");
    world.sessions.add(OWNER_TOKEN);
    const quiet = home as unknown as { quietly(request: Request): Promise<Response> };
    const real = quiet.quietly.bind(home);
    let unanswered = 1;
    vi.spyOn(quiet, "quietly").mockImplementation(async (request) => {
      if (new URL(request.url).pathname === guard.SESSION_CHECK_PATH && unanswered-- > 0) return Response.json({ error: "waking" }, { status: 503 });
      return real(request);
    });
    await visit("/api/bots", asOwner());
    expect(await home.knowsWaker(await guard.wakerKey({ kind: "session", token: OWNER_TOKEN, via: "bearer" }))).toBe(false);
    await visit("/api/bots", asOwner());
    expect(await home.knowsWaker(await guard.wakerKey({ kind: "session", token: OWNER_TOKEN, via: "bearer" }))).toBe(true);
  });

  it("boots by bearer for a session it learned from the browser's cookie", async () => {
    const { visit, sleep, machine } = await awakeHome("owners");
    world.sessions.add(OWNER_TOKEN);
    await visit("/", { headers: { accept: "text/html", cookie: `${COOKIE}=${OWNER_TOKEN}` } });
    await sleep();
    await visit("/api/bots", asOwner());
    expect(machine.running).toBe(true);
  });

  it("learns a webhook the home accepted and boots for its next delivery, but not for a wrong secret", async () => {
    const { visit, sleep, machine } = await awakeHome("owners");
    world.hooks.add(HOOK);
    expect((await visit(HOOK, { method: "POST", body: "{}" })).status).toBe(202);
    await sleep();
    await visit(`/hooks/wh_github/${"x".repeat(32)}`, { method: "POST", body: "{}" });
    expect(machine.running).toBe(false);
    await visit(HOOK, { method: "POST", body: "{}" });
    expect(machine.running).toBe(true);
  });

  it("boots for anyone while a pairing it handed out is still open, and not after", async () => {
    const { api, visit, sleep, machine } = await awakeHome("owners");
    const pairing = await api.pair(OWNER, { label: "Phone", ttlSeconds: 120 });
    expect(pairing.ok).toBe(true);
    await sleep();
    await visit("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(machine.running).toBe(true);

    await sleep();
    now += 121_000;
    await visit("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(machine.running).toBe(false);
  });

  it("forgets a session unseen for a month", async () => {
    const { visit, sleep, machine } = await awakeHome("owners");
    world.sessions.add(OWNER_TOKEN);
    await visit("/api/bots", asOwner());
    await sleep();
    now += guard.WAKER_FORGET_MS;
    await visit("/api/bots", asOwner());
    expect(machine.running).toBe(false);
  });

  it("still knows its owner's sessions after the Durable Object restarts", async () => {
    const { visit, HOMES, machineId, env } = await awakeHome("owners");
    world.sessions.add(OWNER_TOKEN);
    await visit("/api/bots", asOwner());
    const id = HOMES.idFromName(machineId);
    const ctx = fakeContext(id, HOMES.contexts.get(id.toString())!.storage);
    const restarted = new CloudHomeHost(ctx as never, env as never);
    await Promise.all(ctx.pending);
    expect(await restarted.knowsWaker(await guard.wakerKey({ kind: "session", token: OWNER_TOKEN, via: "bearer" }))).toBe(true);
  });

  it("lets a large home that took over boot for sessions the standard home learned, and nobody else", async () => {
    const { env, HOMES, HOMES_LARGE, visit, machineId } = await awakeHome("owners");
    world.sessions.add(OWNER_TOKEN);
    await visit("/api/bots", asOwner());
    const standard = HOMES.machine(machineId);

    env.LARGE_HOME_ACCOUNTS = OWNER;
    await visit("/api/bots", asStranger);
    expect(standard.signals).toBe(0);

    await visit("/api/bots", asOwner());
    expect(standard.signals).toBe(1);
    standard.exit?.();
    await visit("/api/bots", asOwner());
    expect(HOMES_LARGE.machine(machineId).running).toBe(true);
    expect(world.overlaps).toEqual([]);
  });
});
