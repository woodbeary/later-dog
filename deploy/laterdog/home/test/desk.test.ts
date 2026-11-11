import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskBucket, DeskObject } from "../src/desk.ts";
import { base64url, hex, hmacSha256, sha256 } from "../src/encoding.ts";
import { bootstrapSecret } from "../src/identity.ts";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { FakeNamespace, resetWorld, world } = await import("./fake-containers.ts");
const { CloudHomeHost, CloudHomeHostLarge } = await import("../src/host.ts");
const { default: worker, HomesApi } = await import("../src/index.ts");
const { homeIdentity } = await import("../src/identity.ts");
const { WAKE_HEADER } = await import("../src/waking.ts");
const { wakerKey } = await import("../src/wake-guard.ts");
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
  const sleepAfterIdle = async () => {
    await (host as unknown as { onActivityExpired(): Promise<void> }).onActivityExpired();
    machine.exit?.();
    await settle();
  };
  return { STATE, host, machine, machineId, visit, sleep, sleepAfterIdle, deliver, settle };
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
  vi.unstubAllGlobals();
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

  it("opens a busy home's chat list too, though it is longer than other answers the desk keeps", async () => {
    const h = await home();
    const tool = { name: "shell", input: "x".repeat(2_000) };
    const chats = { bots: [{ id: "rex", name: "Rex", messages: Array.from({ length: 2_500 }, (_, index) => ({ id: `m${index}`, tool })) }] };
    expect(JSON.stringify(chats).length).toBeGreaterThan(desk.DESK_READ_MAX_BYTES);
    world.answers.set("GET /api/bots", () => Response.json(chats));
    await knownOwner(h);
    await h.visit("/api/bots?messages=200", asOwner());
    await h.sleep();
    now += 60_000;
    const response = await h.visit("/api/bots?messages=200", asOwner());
    expect(response.status).toBe(200);
    expect(response.headers.get(desk.SAVED_HEADER)).toBeTruthy();
    expect(await response.json()).toEqual(chats);
  });
});

describe("which devices the desk trusts", () => {
  const COOKIE = `laterdog_session_8799_abc123=laterdog_sess_${"k".repeat(43)}`;
  const asBrowser = { headers: { accept: "application/json", cookie: COOKIE } };

  it("serves a browser signed in by cookie once the home has answered it, never replaying its cookie", async () => {
    const h = await home();
    world.sessions.add(COOKIE.slice(COOKIE.indexOf("=") + 1));
    world.answers.set("GET /api/bots", () => Response.json(DOGS, { headers: { "set-cookie": "laterdog_session_8799_abc123=renewed; HttpOnly" } }));
    await h.visit("/api/bots", asBrowser);
    now += 10_000;
    await h.sleep();
    const response = await h.visit("/api/bots", asBrowser);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual(DOGS);
  });

  const BRAND = { name: "later.dog" };
  const send = (h: Awaited<ReturnType<typeof home>>, who: { headers: Record<string, string> }) =>
    h.visit("/api/bots/rex/messages", { method: "POST", headers: { ...who.headers, "content-type": "application/json" }, body: JSON.stringify({ text: "hi", sendId: "send-0000000000009" }) });
  const keptForDevices = (h: Awaited<ReturnType<typeof home>>) => [...h.STATE.objects.keys()].filter((key) => !key.includes("/desk/ui/"));

  it("keeps a confirmed device's first answer, without waiting for a second visit", async () => {
    const h = await home();
    await h.visit("/api/bots", asOwner());
    await h.sleep();
    const response = await h.visit("/api/bots", asOwner());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DOGS);
  });

  it("does not come to trust someone the home never confirmed, though the home tells anyone its name", async () => {
    const h = await home();
    world.answers.set("GET /api/brand", () => Response.json(BRAND));
    expect((await h.visit("/api/brand", asStranger)).status).toBe(200);
    now += 10_000;
    expect((await h.visit("/api/brand?again=1", asStranger)).status).toBe(200);
    expect(keptForDevices(h)).toEqual([]);
    await knownOwner(h);
    await h.sleep();
    expect((await send(h, asStranger)).status).toBe(503);
  });

  it("does not trust a signed-out session again because the home still tells it its name", async () => {
    const h = await home();
    world.answers.set("GET /api/brand", () => Response.json(BRAND));
    await knownOwner(h);
    world.sessions.delete(OWNER_TOKEN);
    world.answers.set("GET /api/bots", () => Response.json({ error: "unauthorized" }, { status: 401 }));
    now += 10_000;
    expect((await h.visit("/api/bots", asOwner())).status).toBe(401);
    now += 10_000;
    expect((await h.visit("/api/brand", asOwner())).status).toBe(200);
    now += 10_000;
    expect((await h.visit("/api/brand", asOwner())).status).toBe(200);
    expect(keptForDevices(h)).toEqual([]);
    await h.sleep();
    expect((await send(h, asOwner())).status).toBe(503);
  });

  it("stops counting a note it once kept for someone the home never confirmed", async () => {
    const h = await home();
    await knownOwner(h);
    const stranger = await wakerKey({ kind: "session", token: STRANGER_TOKEN, via: "bearer" });
    (h.host as unknown as { deskDevices: Record<string, number> }).deskDevices[stranger] = now;
    await h.sleep();
    expect((await send(h, asStranger)).status).toBe(503);
  });

  it("keeps trusting a device whose session still stands when the home refuses it one thing", async () => {
    const h = await home();
    await knownOwner(h);
    world.answers.set("POST /api/bots/rex/avatar", () => Response.json({ error: "the image service refused its key" }, { status: 401 }));
    now += 10_000;
    expect((await h.visit("/api/bots/rex/avatar", asOwner({ method: "POST" }))).status).toBe(401);
    await h.sleep();
    expect((await send(h, asOwner())).status).toBe(202);
  });

  it("asks the home again about a session it last checked a day ago, and stops trusting one signed out since", async () => {
    const h = await home();
    world.answers.set("GET /api/brand", () => Response.json(BRAND));
    await knownOwner(h);
    world.sessions.delete(OWNER_TOKEN);
    now += 25 * 60 * 60 * 1000;
    expect((await h.visit("/api/brand", asOwner())).status).toBe(200);
    expect(keptForDevices(h)).toEqual([]);
    await h.sleep();
    expect((await h.visit("/api/bots", asOwner())).status).toBe(503);
  });

  it.each([
    ["the check ends with no clear answer", () => new Response(null, { status: 500 })],
    ["the check fails", () => Promise.reject(new Error("the home hung up"))],
    ["the check was answered just before the sign-out", () => Response.json({ kind: "session", scopes: ["admin", "client"] })],
  ])("stops trusting a session the home refuses while an older check of it is still out, when %s", async (_, answer) => {
    const h = await home();
    world.answers.set("GET /api/brand", () => Response.json(BRAND));
    await knownOwner(h);
    now += 25 * 60 * 60 * 1000;
    let letGo = () => undefined as void;
    const out = new Promise<void>((asked) => {
      world.answers.set("GET /api/auth/session", () => {
        asked();
        return new Promise<Response>((resolve, reject) => {
          letGo = () => void Promise.resolve().then(answer).then(resolve, reject);
        });
      });
    });
    const checksBefore = world.sessionChecks;
    const dayOld = h.visit("/api/brand", asOwner());
    await out;
    world.answers.delete("GET /api/auth/session");
    world.sessions.delete(OWNER_TOKEN);
    world.answers.set("GET /api/bots", () => Response.json({ error: "unauthorized" }, { status: 401 }));
    expect((await h.visit("/api/bots", asOwner())).status).toBe(401);
    letGo();
    expect((await dayOld).status).toBe(200);
    await h.settle();
    expect(world.sessionChecks - checksBefore).toBe(1);
    expect(keptForDevices(h)).toEqual([]);
    await h.sleep();
    expect((await send(h, asOwner())).status).toBe(503);
  });

  it("asks the home once more, and only once, about a standing session it refuses one thing again and again while a check of it is out", async () => {
    const h = await home();
    await knownOwner(h);
    world.answers.set("POST /api/bots/rex/avatar", () => Response.json({ error: "the image service refused its key" }, { status: 401 }));
    const refusedOneThing = () => h.visit("/api/bots/rex/avatar", asOwner({ method: "POST" }));
    let letGo = () => undefined as void;
    const out = new Promise<void>((asked) => {
      world.answers.set("GET /api/auth/session", () => {
        asked();
        return new Promise<Response>((resolve) => {
          letGo = () => resolve(Response.json({ kind: "session", scopes: ["admin", "client"] }));
        });
      });
    });
    now += 10_000;
    const first = refusedOneThing();
    await out;
    let askedAgain = 0;
    world.answers.set("GET /api/auth/session", () => {
      askedAgain += 1;
      return askedAgain === 1 ? Response.json({ kind: "session", scopes: ["admin", "client"] }) : Response.json({ error: "unauthorized" }, { status: 401 });
    });
    for (let again = 0; again < 5; again += 1) expect((await refusedOneThing()).status).toBe(401);
    expect(askedAgain).toBe(0);
    letGo();
    expect((await first).status).toBe(401);
    await h.settle();
    expect(askedAgain).toBe(1);
    await h.sleep();
    expect((await send(h, asOwner())).status).toBe(202);
  });

  it.each([
    ["answers the check with an error", () => new Response(null, { status: 500 })],
    ["hangs up on the check", () => Promise.reject(new Error("the home hung up"))],
  ])("stops trusting a session the home refuses one thing when the home %s, until the home confirms it again", async (_, answer) => {
    const h = await home();
    await knownOwner(h);
    world.answers.set("POST /api/bots/rex/avatar", () => Response.json({ error: "the image service refused its key" }, { status: 401 }));
    let asked = 0;
    world.answers.set("GET /api/auth/session", () => {
      asked += 1;
      return answer();
    });
    now += 10_000;
    expect((await h.visit("/api/bots/rex/avatar", asOwner({ method: "POST" }))).status).toBe(401);
    expect(asked).toBe(1);
    expect(keptForDevices(h)).toEqual([]);
    world.answers.delete("GET /api/auth/session");
    await h.sleep();
    expect((await send(h, asOwner())).status).toBe(503);
    now += 10_000;
    expect((await h.visit("/api/bots", asOwner())).status).toBe(200);
    await h.sleep();
    expect((await send(h, asOwner())).status).toBe(202);
  });

  it("keeps a device's answers again once the home accepts it again, though they have not changed", async () => {
    const h = await home();
    await knownOwner(h);
    world.sessions.delete(OWNER_TOKEN);
    world.answers.set("GET /api/bots", () => Response.json({ error: "unauthorized" }, { status: 401 }));
    now += 10_000;
    expect((await h.visit("/api/bots", asOwner())).status).toBe(401);
    world.sessions.add(OWNER_TOKEN);
    world.answers.set("GET /api/bots", () => Response.json(DOGS));
    (h.host as unknown as { refused: Set<string> }).refused.clear();
    now += 10_000;
    await h.visit("/api/bots", asOwner());
    await h.sleep();
    const response = await h.visit("/api/bots", asOwner());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DOGS);
  });

  it("forgets a device the home stops accepting, and what it kept for it", async () => {
    const h = await home();
    await knownOwner(h);
    world.sessions.delete(OWNER_TOKEN);
    world.answers.set("GET /api/bots", () => Response.json({ error: "unauthorized" }, { status: 401 }));
    now += 10_000;
    expect((await h.visit("/api/bots", asOwner())).status).toBe(401);
    await h.sleep();
    expect((await h.visit("/api/bots", asOwner())).status).toBe(503);
    expect([...h.STATE.objects.keys()].filter((key) => !key.includes("/desk/ui/"))).toEqual([]);
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
    const first = await send("first", "send-0000000000001");
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ ok: true, queued: true, queueId: "send-0000000000001" });
    expect((await send("second", "send-0000000000002")).status).toBe(202);
    expect((await send("first", "send-0000000000001")).status).toBe(202);
    expect((await send("bad id", "s3")).status).toBe(400);
    expect(received).toEqual([]);
    h.machine.serving = true;
    now += 6_000;
    await h.deliver();
    expect(received).toEqual([{ text: "first", sendId: "send-0000000000001" }, { text: "second", sendId: "send-0000000000002" }]);
  });

  it("answers Send now for a held message in words, and cancel drops it before the home ever sees it", async () => {
    const h = await home();
    const received: unknown[] = [];
    world.answers.set("POST /api/bots/rex/messages", async (request) => {
      received.push(await request.json());
      return Response.json({ ok: true }, { status: 202 });
    });
    await knownOwner(h);
    await h.sleep();
    h.machine.serving = false;
    const json = { "content-type": "application/json" };
    const send = (text: string, sendId: string) => h.visit("/api/bots/rex/messages", asOwner({ method: "POST", headers: json, body: JSON.stringify({ text, sendId, threadId: "t-rex" }) }));
    await send("keep me", "send-0000000000001");
    await send("drop me", "send-0000000000002");
    const sendNow = await h.visit("/api/bots/rex/queue/send-0000000000001/steer", asOwner({ method: "POST", headers: json, body: JSON.stringify({ threadId: "t-rex" }) }));
    expect(sendNow.status).toBe(200);
    expect(await sendNow.json()).toEqual({ ok: true, queued: true, reason: desk.HELD_UNTIL_UP, threadId: "t-rex" });
    const cancel = await h.visit("/api/bots/rex/queue/send-0000000000002", asOwner({ method: "DELETE", headers: json, body: JSON.stringify({ threadId: "t-rex" }) }));
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ ok: true });
    const unknown = await h.visit("/api/bots/rex/queue/send-0000000000009/steer", asOwner({ method: "POST", headers: json, body: "{}" }));
    expect(unknown.status).toBe(503);
    const stranger = await h.visit("/api/bots/rex/queue/send-0000000000001", { ...asStranger, method: "DELETE" });
    expect(stranger.status).toBe(503);
    h.machine.serving = true;
    now += 6_000;
    await h.deliver();
    expect(received).toEqual([{ text: "keep me", sendId: "send-0000000000001", threadId: "t-rex" }]);
  });

  it("says which messages it holds to a session the home confirmed, and nothing to a stranger or to a caller with no credential", async () => {
    const h = await home();
    await knownOwner(h);
    await h.sleep();
    h.machine.serving = false;
    const json = { "content-type": "application/json" };
    const sent = await h.visit("/api/bots/rex/messages", asOwner({ method: "POST", headers: json, body: JSON.stringify({ text: "keep me", sendId: "send-0000000000001", threadId: "t-rex" }) }));
    expect(sent.status).toBe(202);
    const list = "/api/held-sends?ids=send-0000000000001";
    const stranger = await h.visit(list, asStranger);
    expect(stranger.status).toBe(503);
    expect(await stranger.text()).not.toContain("send-0000000000001");
    const nobody = await h.visit(list, { headers: { accept: "application/json" } });
    expect(nobody.status).toBe(503);
    expect(await nobody.text()).not.toContain("send-0000000000001");
    const owner = await h.visit(list, asOwner());
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ held: ["send-0000000000001"], dropped: [] });
  });

  it("reads Send now and cancel for a queued message, and nothing else", () => {
    const ask = (method: string, path: string) => desk.heldQueueAsk(new Request(`https://home.example${path}`, { method }));
    expect(ask("POST", "/api/bots/dog-1/queue/send-1/steer")).toEqual({ id: "send-1", ask: "send-now" });
    expect(ask("DELETE", "/api/bots/dog-1/queue/send-1")).toEqual({ id: "send-1", ask: "cancel" });
    expect(ask("GET", "/api/bots/dog-1/queue/send-1")).toBeNull();
    expect(ask("DELETE", "/api/bots/dog-1/queue/send-1/steer")).toBeNull();
    expect(ask("POST", "/api/bots/dog-1/messages")).toBeNull();
    expect(ask("POST", "/api/groups/room-1/queue/send-1/steer")).toEqual({ id: "send-1", ask: "send-now" });
    expect(ask("DELETE", "/api/groups/room-1/queue/send-1")).toEqual({ id: "send-1", ask: "cancel" });
    expect(ask("DELETE", "/api/rooms/room-1/queue/send-1")).toBeNull();
    expect(desk.HELD_UNTIL_UP).not.toMatch(/object|undefined/i);
  });

  it("answers Send now and cancel for a message held for a group chat", async () => {
    const h = await home();
    await knownOwner(h);
    await h.sleep();
    h.machine.serving = false;
    const json = { "content-type": "application/json" };
    const received: unknown[] = [];
    world.answers.set("POST /api/groups/pack/messages", async (request) => {
      received.push(await request.json());
      return Response.json({ ok: true }, { status: 202 });
    });
    const send = (text: string, sendId: string) => h.visit("/api/groups/pack/messages", asOwner({ method: "POST", headers: json, body: JSON.stringify({ text, sendId }) }));
    expect((await send("keep me", "send-0000000000001")).status).toBe(202);
    expect((await send("drop me", "send-0000000000002")).status).toBe(202);
    const sendNow = await h.visit("/api/groups/pack/queue/send-0000000000001/steer", asOwner({ method: "POST", headers: json, body: "{}" }));
    expect(await sendNow.json()).toEqual({ ok: true, queued: true, reason: desk.HELD_UNTIL_UP });
    const cancel = await h.visit("/api/groups/pack/queue/send-0000000000002", asOwner({ method: "DELETE" }));
    expect(await cancel.json()).toEqual({ ok: true });
    h.machine.serving = true;
    now += 6_000;
    await h.deliver();
    expect(received).toEqual([{ text: "keep me", sendId: "send-0000000000001" }]);
  });

  it("refuses to cancel a message a dog is already answering, in words, and says the same to Send now", async () => {
    const waiting = { id: "send-0000000000001", path: "/api/bots/rex/messages", headers: {}, body: "{}", at: 0 };
    const answered = { ...waiting, id: "send-0000000000002", reply: { text: "Woof.", model: "kimi-k2.6" } };
    const outbox = [waiting, answered];
    const underway = desk.answerHeldQueueAsk(outbox, { id: waiting.id, ask: "cancel" }, new Set([waiting.id]));
    expect(underway?.response.status).toBe(409);
    expect(await underway?.response.json()).toEqual({ error: desk.ALREADY_ANSWERING });
    expect(underway?.outbox).toEqual(outbox);
    const done = desk.answerHeldQueueAsk(outbox, { id: answered.id, ask: "cancel" });
    expect(done?.response.status).toBe(409);
    expect(done?.outbox).toEqual(outbox);
    const sendNow = desk.answerHeldQueueAsk(outbox, { id: waiting.id, ask: "send-now" }, new Set([waiting.id]));
    expect(await sendNow?.response.json()).toMatchObject({ ok: true, queued: true, reason: desk.ALREADY_ANSWERING });
    expect(desk.answerHeldQueueAsk(outbox, { id: waiting.id, ask: "cancel" })?.outbox).toEqual([answered]);
    expect(desk.ALREADY_ANSWERING).not.toMatch(/object|undefined/i);
  });

  it("names the thread in its receipt so the desktop shows the message as waiting", async () => {
    const h = await home();
    await knownOwner(h);
    await h.sleep();
    const response = await h.visit("/api/bots/rex/messages", asOwner({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi", sendId: "send-0000000000001", threadId: "t-rex" }) }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, queued: true, queueId: "send-0000000000001", threadId: "t-rex" });
  });

  it("keeps a waiting message in the saved chat list, so a refresh while the home sleeps does not drop it", async () => {
    const h = await home();
    world.answers.set("GET /api/bots", () => Response.json({ bots: [{ id: "rex", name: "Rex", threadId: "t-rex", messages: [] }], botQueuedMessages: {} }));
    await knownOwner(h);
    await h.sleep();
    h.machine.serving = false;
    const send = (body: Record<string, string>) => h.visit("/api/bots/rex/messages", asOwner({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await send({ text: "from the phone", sendId: "phone-00000000000001" })).status).toBe(202);
    expect((await send({ text: "from the desktop", sendId: "send-0000000000002", threadId: "t-rex" })).status).toBe(202);
    const chats = await (await h.visit("/api/bots", asOwner())).json() as { botQueuedMessages: Record<string, unknown[]> };
    expect(chats.botQueuedMessages).toEqual({
      "t-rex": [
        { queueId: "phone-00000000000001", text: "from the phone", sendId: "phone-00000000000001" },
        { queueId: "send-0000000000002", text: "from the desktop", sendId: "send-0000000000002" },
      ],
    });
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
    expect(desk.savable("read", Response.json({}, { headers: { "set-cookie": "a=b" } }))).toBe(true);
    expect(desk.savable("shell", new Response("", { headers: { "content-type": "text/html", "cache-control": "no-store" } }))).toBe(false);
  });

  it("holds the chat list to a larger limit than the other answers", async () => {
    const bucket = memoryBucket();
    const long = () => Response.json({ notes: "x".repeat(desk.DESK_READ_MAX_BYTES) });
    expect(await desk.saveAnswer(bucket, "routines", long(), desk.deskLimit("read", get("/api/routines")), T0)).toBeNull();
    expect(await desk.saveAnswer(bucket, "chats", long(), desk.deskLimit("read", get("/api/bots?messages=200")), T0)).toBeTruthy();
    expect([...bucket.objects.keys()]).toEqual(["chats"]);
    expect(desk.deskLimit("read", get("/api/bots/rex/messages?limit=30"))).toBe(desk.DESK_READ_MAX_BYTES);
    expect(desk.deskLimit("shell", get("/assets/index-abc.js"))).toBe(desk.DESK_SHELL_MAX_BYTES);
  });

  it("retries a send the home could not take and drops one it refused", () => {
    expect(desk.deliveryOutcome(null)).toBe("retry");
    expect(desk.deliveryOutcome(503)).toBe("retry");
    expect(desk.deliveryOutcome(202)).toBe("delivered");
    expect(desk.deliveryOutcome(400)).toBe("refused");
  });
});

describe("answering while the home sleeps", () => {
  const SEND_ID = "send-0000000000001";
  const REX = { botId: "rex", threadId: "t-rex", name: "Rex", instanceId: "laterdogAi", model: "kimi-k2.6", system: "You are Rex.", transcript: [], leafId: "m1" };
  const CHATS = { bots: [{ id: "rex", name: "Rex", threadId: "t-rex", activeLeafId: "m1", messages: [{ id: "m1", at: T0, role: "user", kind: "text", text: "Good morning" }] }], botQueuedMessages: {} };
  const send = (h: Awaited<ReturnType<typeof home>>, text = "hello?") =>
    h.visit("/api/bots/rex/messages", asOwner({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, sendId: SEND_ID, threadId: "t-rex" }) }));
  const model = (frames: unknown[]) => {
    const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const words = (content: string) => ({ model: "kimi-k2.6", choices: [{ index: 0, delta: { content } }] });

  async function asleepWithNotes(answer: () => Response) {
    const h = await home();
    world.answers.set("GET /api/bots", () => Response.json(CHATS));
    world.answers.set("GET /api/cloud/desk/brain", () => Response.json({ at: T0, dogs: [REX] }));
    const delivered: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    world.answers.set("POST /api/bots/rex/messages", async (request) => {
      delivered.push({ body: await request.json() as Record<string, unknown>, headers: request.headers });
      return Response.json({ ok: true }, { status: 202 });
    });
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(String(url));
      return answer();
    });
    await knownOwner(h);
    await h.sleepAfterIdle();
    h.machine.serving = false;
    return { h, delivered, asked };
  }

  it("answers a free-model dog at once, and the home records that answer when it wakes instead of answering again", async () => {
    const { h, delivered, asked } = await asleepWithNotes(() => model([words("Woof! "), words("Hello.")]));
    expect((await send(h)).status).toBe(202);
    await h.settle();
    expect(asked).toEqual(["https://cloud.later.dog/v1/ai/chat/completions"]);
    const chats = await (await h.visit("/api/bots", asOwner())).json() as { bots: Array<{ activeLeafId: string; messages: Array<Record<string, unknown>> }>; botQueuedMessages: unknown };
    expect(chats.bots[0]!.messages.slice(-2)).toMatchObject([
      { id: `desk-${SEND_ID}`, role: "user", kind: "text", text: "hello?", sendId: SEND_ID, parentId: "m1" },
      { id: `desk-${SEND_ID}-reply`, role: "bot", kind: "text", text: "Woof! Hello.", turnTerminal: true, parentId: `desk-${SEND_ID}` },
    ]);
    expect(chats.bots[0]!.activeLeafId).toBe(`desk-${SEND_ID}-reply`);
    expect(chats.botQueuedMessages).toEqual({});
    h.machine.serving = true;
    now += 6_000;
    await h.deliver();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.body).toEqual({ text: "hello?", sendId: SEND_ID, threadId: "t-rex", deskReply: { text: "Woof! Hello.", model: "kimi-k2.6" } });
    const headers = delivered[0]!.headers;
    const timestamp = headers.get("x-laterdog-cloud-timestamp")!;
    const nonce = headers.get("x-laterdog-cloud-nonce")!;
    const secret = await bootstrapSecret(SECRET, h.machineId);
    const signed = base64url(await hmacSha256(secret, ["v1", timestamp, nonce, "POST", "/api/bots/rex/messages", SEND_ID, hex(await sha256("Woof! Hello."))].join("\n")));
    expect(headers.get("x-laterdog-cloud-signature")).toBe(`v1=${signed}`);
    expect(headers.get("authorization")).toBe(`Bearer ${OWNER_TOKEN}`);
  });

  it("keeps its notes fresh while the home is in use, so an abrupt stop still leaves recent ones", async () => {
    const h = await home();
    world.answers.set("GET /api/bots", () => Response.json(CHATS));
    world.answers.set("GET /api/cloud/desk/brain", () => Response.json({ at: T0, dogs: [REX] }));
    vi.stubGlobal("fetch", async () => model([words("Hi!")]));
    await knownOwner(h);
    await h.sleep();
    h.machine.serving = false;
    expect((await send(h)).status).toBe(202);
    await h.settle();
    const chats = await (await h.visit("/api/bots", asOwner())).json() as { bots: Array<{ messages: Array<{ text?: string }> }> };
    expect(chats.bots[0]!.messages.at(-1)?.text).toBe("Hi!");
  });

  it("leaves the message for the home when the dog needs its computer", async () => {
    const { h, delivered } = await asleepWithNotes(() => model([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "wake_up", arguments: "{}" } }] } }] }]));
    expect((await send(h, "list my files")).status).toBe(202);
    await h.settle();
    const chats = await (await h.visit("/api/bots", asOwner())).json() as { botQueuedMessages: Record<string, unknown[]> };
    expect(chats.botQueuedMessages["t-rex"]).toEqual([{ queueId: SEND_ID, text: "list my files", sendId: SEND_ID }]);
    h.machine.serving = true;
    now += 6_000;
    await h.deliver();
    expect(delivered.map((entry) => entry.body)).toEqual([{ text: "list my files", sendId: SEND_ID, threadId: "t-rex" }]);
  });

  it("streams the answer to the owner's open app and closes that stream once the home is up", async () => {
    const { h } = await asleepWithNotes(() => model([words("<think>Say hello.</think>"), words("Hi "), words("there!")]));
    const live = await h.visit("/api/events?screens=off", asOwner({ headers: { accept: "text/event-stream" } }));
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toBe("text/event-stream");
    const stranger = await h.visit("/api/events", asStranger);
    expect(stranger.status).toBe(503);
    expect((await send(h)).status).toBe(202);
    await h.settle();
    const reader = live.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    for (let reads = 0; reads < 20 && !text.includes("turn.completed"); reads++) text += (await reader.read()).value ?? "";
    const frames = text.split("\n\n").flatMap((block) => block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))));
    expect(frames[0]).toMatchObject({ kind: "hello", resumed: false });
    expect(frames.slice(1).map((frame) => frame.kind === "runtime" ? `${frame.event.type}${frame.event.delta ? `:${frame.event.delta}` : ""}` : `${frame.kind}:${frame.message.role}`)).toEqual([
      "message:user", "turn.started", "content.delta:Hi ", "content.delta:there!", "message:bot", "turn.completed",
    ]);
    expect(frames[1].message).toMatchObject({ sendId: SEND_ID, queueId: SEND_ID, parentId: "m1" });
    expect(frames[1].threadId).toBe("t-rex");
    h.machine.serving = true;
    await h.visit("/api/bots", asOwner());
    for (let reads = 0; reads < 5; reads++) if ((await reader.read()).done) return;
    throw new Error("the desk stream stayed open after the home came up");
  });
});

describe("what became of a message the desk was holding", () => {
  const held = (id: string, at = 0) => ({ id, path: "/api/bots/rex/messages", headers: {}, body: "{}", at });
  const ask = (query: string, method = "GET") => desk.heldSendsAsk(new Request(`https://home.example/api/held-sends${query}`, { method }));

  it("reads only well-formed send ids from the question, and ignores other paths and methods", () => {
    expect(ask("?ids=send-0000000000001,short,send-0000000000002")).toEqual(["send-0000000000001", "send-0000000000002"]);
    expect(ask("")).toEqual([]);
    expect(ask("?ids=send-0000000000001", "POST")).toBeNull();
    expect(desk.heldSendsAsk(new Request("https://home.example/api/bots"))).toBeNull();
  });

  it("reads a send id from a message's body, and nothing from anything else", () => {
    expect(desk.sendIdOf(JSON.stringify({ text: "hi", sendId: "send-0000000000001" }))).toBe("send-0000000000001");
    expect(desk.sendIdOf(JSON.stringify({ text: "hi", sendId: "short" }))).toBeNull();
    expect(desk.sendIdOf(JSON.stringify({ text: "hi" }))).toBeNull();
    expect(desk.sendIdOf("not json")).toBeNull();
    expect(desk.sendIdOf("null")).toBeNull();
  });

  it("answers held and dropped for the ids asked about, and nothing about anyone else's", async () => {
    const answer = desk.heldSendsAnswer(
      [held("send-0000000000001"), held("send-0000000000009")],
      [{ id: "send-0000000000002", why: "refused", at: 5 }, { id: "send-0000000000008", why: "expired", at: 6 }],
      ["send-0000000000001", "send-0000000000002", "send-0000000000003"],
    );
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.json()).toEqual({ held: ["send-0000000000001"], dropped: [{ id: "send-0000000000002", why: "refused", at: 5 }] });
  });

  it("remembers a dropped message once, forgets old ones after the kept time, and keeps a bounded list", () => {
    const once = desk.withDropped([], [held("send-0000000000001")], "expired", 1_000);
    expect(once).toEqual([{ id: "send-0000000000001", why: "expired", at: 1_000 }]);
    expect(desk.withDropped(once, [held("send-0000000000001")], "refused", 2_000)).toEqual(once);
    expect(desk.withDropped(once, [held("send-0000000000002")], "refused", 1_000 + desk.DESK_KEPT_MS)).toEqual([{ id: "send-0000000000002", why: "refused", at: 1_000 + desk.DESK_KEPT_MS }]);
    expect(desk.droppedStillKept(once, 1_000 + desk.DESK_KEPT_MS - 1)).toEqual(once);
    expect(desk.droppedStillKept(once, 1_000 + desk.DESK_KEPT_MS)).toEqual([]);
    expect(desk.withoutDropped(once, ["send-0000000000001"])).toEqual([]);
    expect(desk.withoutDropped(once, ["send-0000000000002"])).toEqual(once);
    const many = Array.from({ length: desk.DESK_DROPPED_MAX + 5 }, (_, index) => held(`send-${String(index).padStart(13, "0")}`));
    const bounded = desk.withDropped([], many, "expired", 10);
    expect(bounded).toHaveLength(desk.DESK_DROPPED_MAX);
    expect(bounded.at(-1)?.id).toBe(many.at(-1)?.id);
  });
});
