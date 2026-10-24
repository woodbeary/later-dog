import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskBucket, DeskObject } from "../src/desk.ts";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { FakeNamespace, resetWorld, world } = await import("./fake-containers.ts");
const { CloudHomeHost, CloudHomeHostLarge } = await import("../src/host.ts");
const { default: worker, HomesApi } = await import("../src/index.ts");
const { homeIdentity } = await import("../src/identity.ts");
const { WAKE_HEADER } = await import("../src/waking.ts");
const desk = await import("../src/desk.ts");

const OWNER = "owner-account";
const SECRET = "test-home-secret";
const SUFFIX = "-home.later.dog";
const T0 = Date.UTC(2026, 9, 24, 3);
const OWNER_TOKEN = `laterdog_sess_${"o".repeat(43)}`;
const STRANGER_TOKEN = `laterdog_sess_${"s".repeat(43)}`;

type Host = InstanceType<typeof CloudHomeHost>;

function memoryBucket() {
  const objects = new Map<string, { bytes: ArrayBuffer; contentType: string; custom: Record<string, string> }>();
  const bucket: DeskBucket & { objects: typeof objects; head(): Promise<null> } = {
    objects,
    head: async () => null,
    async get(key): Promise<DeskObject | null> {
      const found = objects.get(key);
      return found ? { body: new Response(found.bytes).body, httpMetadata: { contentType: found.contentType }, customMetadata: found.custom } : null;
    },
    async put(key, value, options) {
      objects.set(key, { bytes: value, contentType: options.httpMetadata.contentType, custom: options.customMetadata });
      return {};
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
  return bucket;
}

async function home() {
  const HOMES = new FakeNamespace<Host>("HOMES");
  const HOMES_LARGE = new FakeNamespace<Host>("HOMES_LARGE");
  const STATE = memoryBucket();
  const env: Record<string, unknown> = {
    HOME_SECRET: SECRET, HOME_HOST_SUFFIX: SUFFIX, ADMIN_ORIGIN: "https://accounts.later.dog", INCLUDED_API: "https://cloud.later.dog/v1",
    LARGE_HOME_ACCOUNTS: "", ALWAYS_ON_ACCOUNTS: "", HOMES, HOMES_LARGE, STATE,
    COMPUTERS: { fetch: async () => Response.json({ trial: { state: "active" } }, { status: 201 }) }, ACCOUNTS: {},
  };
  HOMES.bind((ctx) => new CloudHomeHost(ctx as never, env as never));
  HOMES_LARGE.bind((ctx) => new CloudHomeHostLarge(ctx as never, env as never));
  const api = new HomesApi({} as never, env as never);
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) {
      await HOMES.settle();
      await HOMES_LARGE.settle();
    }
  };
  await api.open(OWNER);
  await settle();
  const machineId = (await homeIdentity(SECRET, OWNER, SUFFIX)).machineId;
  const host = HOMES.get(HOMES.idFromName(machineId));
  const machine = HOMES.machine(machineId);
  const visit = async (path: string, init: RequestInit = {}) => {
    const response = await worker.fetch(new Request(`https://${machineId}${SUFFIX}${path}`, init), env as never);
    await settle();
    return response;
  };
  const sleep = async () => {
    await (host as unknown as { stop(): Promise<void> }).stop();
    machine.exit?.();
  };
  const deliver = async () => {
    await (host as unknown as { deliverQueued(): Promise<void> }).deliverQueued();
    await settle();
  };
  return { STATE, machine, visit, sleep, deliver, settle };
}

const asOwner = (extra: RequestInit = {}) => ({ ...extra, headers: { accept: "application/json", authorization: `Bearer ${OWNER_TOKEN}`, ...(extra.headers as Record<string, string> | undefined) } });
const asStranger = { headers: { accept: "application/json", authorization: `Bearer ${STRANGER_TOKEN}` } };
const DOGS = { bots: [{ id: "rex", name: "Rex", messages: [{ id: "m1", text: "Good morning" }] }] };

let now = T0;
beforeEach(() => {
  resetWorld();
  now = T0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  world.sessions.add(OWNER_TOKEN);
  world.answers.set("GET /api/bots", () => Response.json(DOGS));
  world.answers.set("GET /", () => new Response("<!doctype html><title>later.dog</title>", { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function knownOwner(h: Awaited<ReturnType<typeof home>>) {
  await h.visit("/api/bots", asOwner());
  now += 10_000;
  await h.visit("/api/bots", asOwner());
}

describe("chats while the home sleeps", () => {
  it("opens with the owner's last chats at once and wakes the home behind them", async () => {
    const h = await home();
    await knownOwner(h);
    await h.sleep();
    const starts = h.machine.starts;
    now += 60_000;
    const response = await h.visit("/api/bots", asOwner());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DOGS);
    expect(response.headers.get(desk.SAVED_HEADER)).toBeTruthy();
    expect(h.machine.starts).toBe(starts + 1);
  });

  it("shows nothing saved to someone the home never confirmed", async () => {
    const h = await home();
    await knownOwner(h);
    await h.sleep();
    const response = await h.visit("/api/bots", asStranger);
    expect(response.status).toBe(503);
    expect(response.headers.get(WAKE_HEADER)).not.toBeNull();
  });

  it("opens the app's own page while asleep instead of the resting page", async () => {
    const h = await home();
    await h.visit("/", { headers: { accept: "text/html" } });
    await h.sleep();
    const page = await h.visit("/", { headers: { accept: "text/html" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>later.dog</title>");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("forgets saved chats a week old", async () => {
    const h = await home();
    await knownOwner(h);
    await h.sleep();
    now += desk.DESK_KEPT_MS + 1;
    expect((await h.visit("/api/bots", asOwner())).status).toBe(503);
  });
});

describe("sending while the home sleeps", () => {
  it("takes the message at once and hands it to the home, in order, once it answers", async () => {
    const h = await home();
    const received: unknown[] = [];
    world.answers.set("POST /api/bots/rex/messages", async (request) => {
      received.push(await request.json());
      return Response.json({ ok: true }, { status: 202 });
    });
    await knownOwner(h);
    await h.sleep();
    h.machine.serving = false;
    const send = (text: string, sendId: string) => h.visit("/api/bots/rex/messages", asOwner({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, sendId }) }));
    const first = await send("first", "s1");
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ ok: true, queued: true, queueId: "s1" });
    expect((await send("second", "s2")).status).toBe(202);
    expect((await send("first", "s1")).status).toBe(202);
    expect(received).toEqual([]);
    h.machine.serving = true;
    now += 6_000;
    await h.deliver();
    expect(received).toEqual([{ text: "first", sendId: "s1" }, { text: "second", sendId: "s2" }]);
  });

  it("does not queue a stranger's message", async () => {
    const h = await home();
    await knownOwner(h);
    await h.sleep();
    const response = await h.visit("/api/bots/rex/messages", { method: "POST", headers: { ...asStranger.headers, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    expect(response.status).toBe(503);
  });
});

describe("what the desk keeps", () => {
  const get = (path: string) => new Request(`https://h1-home.later.dog${path}`);

  it("keeps API answers and the app's files, never streams, sign-in steps, computers or files", () => {
    expect(desk.deskKind(get("/api/bots?messages=200"))).toBe("read");
    expect(desk.deskKind(get("/api/threads/t1/messages?limit=30"))).toBe("read");
    expect(desk.deskKind(get("/assets/index-abc.js"))).toBe("shell");
    for (const path of ["/api/events?screens=off", "/api/health", "/api/auth/pair", "/api/bots/rex/computer/join", "/api/files/x", "/hooks/wh_x/abc"]) expect(desk.deskKind(get(path))).toBeNull();
    expect(desk.deskKind(new Request("https://h1-home.later.dog/api/bots", { method: "POST" }))).toBeNull();
  });

  it("keeps only plain successful answers", () => {
    expect(desk.savable("read", Response.json({}))).toBe(true);
    expect(desk.savable("read", new Response("x", { headers: { "content-type": "text/plain" } }))).toBe(false);
    expect(desk.savable("read", Response.json({}, { status: 401 }))).toBe(false);
    expect(desk.savable("read", Response.json({}, { headers: { "set-cookie": "a=b" } }))).toBe(false);
    expect(desk.savable("shell", new Response("", { headers: { "content-type": "text/html", "cache-control": "no-store" } }))).toBe(false);
  });

  it("retries a send the home could not take and drops one it refused", () => {
    expect(desk.deliveryOutcome(null)).toBe("retry");
    expect(desk.deliveryOutcome(503)).toBe("retry");
    expect(desk.deliveryOutcome(202)).toBe("delivered");
    expect(desk.deliveryOutcome(400)).toBe("refused");
  });
});
