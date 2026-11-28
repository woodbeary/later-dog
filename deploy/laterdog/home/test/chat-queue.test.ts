import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
  WorkerEntrypoint: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}));

const { chatQueue, chatHistory, dogSlots, CANCELLED_KEPT_MS } = await import("../src/chat-queue.ts");
const { serveQueue, serveHistory, coordinate } = await import("../src/coordinator.ts");
const { CAPABILITY_CLAIMS_HEADER } = await import("../src/edge-routes.ts");
type Claims = import("../../../../shared/signed-capability.ts").SignedCapabilityClaims;

const HOME = "h0123456789abcdef01234567";
const claims = (chat: string, kind: Claims["kind"] = "turns"): Claims => ({ home: HOME, dog: "bot-1", chat, generation: "queue", kind, issuedAt: 1, expiresAt: Date.now() + 60_000 });

function sql(database = new DatabaseSync(":memory:")) {
  return {
    exec: (query: string, ...bindings: unknown[]) => {
      const rows = database.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}

function memoryStorage() {
  const rows = new Map<string, unknown>();
  return { async get<T>(key: string) { return rows.get(key) as T | undefined; }, async put<T>(key: string, value: T) { rows.set(key, structuredClone(value)); } };
}

function ports() {
  const chats = new Map<string, ReturnType<typeof chatQueue> & ReturnType<typeof chatHistory>>();
  const chatObject = () => { const db = sql(); return { ...chatQueue(db), ...chatHistory(db) }; };
  const dogs = new Map<string, ReturnType<typeof dogSlots>>();
  return {
    dog: (home: string, dog: string) => dogs.get(`${home}/${dog}`) ?? dogs.set(`${home}/${dog}`, dogSlots(memoryStorage())).get(`${home}/${dog}`)!,
    chat: (home: string, chat: string) => chats.get(`${home}/${chat}`) ?? chats.set(`${home}/${chat}`, chatObject()).get(`${home}/${chat}`)!,
  };
}

const op = async (p: ReturnType<typeof ports>, chat: string, body: Record<string, unknown>) => (await serveQueue(body, claims(chat), p)).json() as Promise<Record<string, any>>;

describe("chat queue", () => {
  it("keeps rows in arrival order, once per id, and settles them", async () => {
    const queue = chatQueue(sql());
    await queue.put([{ id: "a", sendId: "s-a", status: "pending", payload: { text: "one" }, at: 1 }, { id: "b", status: "pending", payload: { text: "two" }, at: 2 }]);
    await queue.put([{ id: "a", sendId: "s-a", status: "dispatching", payload: { text: "one" }, at: 1 }]);
    expect((await queue.rows()).map((row) => [row.id, row.status])).toEqual([["a", "dispatching"], ["b", "pending"]]);
    await queue.settle(["a"], null);
    await queue.settle(["b"], "cancelled");
    expect((await queue.rows()).map((row) => [row.id, row.status, row.sendId])).toEqual([["b", "cancelled", null]]);
  });

  it("clears started and dispatching rows when the chat's slot is released, and keeps pending ones", async () => {
    const queue = chatQueue(sql());
    await queue.put([
      { id: "x", status: "accepted", payload: {}, at: 10 },
      { id: "y", status: "dispatching", payload: {}, at: 11 },
      { id: "z", status: "pending", payload: {}, at: 12 },
      { id: "w", status: "accepted", payload: {}, at: 50 },
    ]);
    expect(await queue.release(20)).toBe(2);
    expect((await queue.rows()).map((row) => row.id)).toEqual(["z", "w"]);
  });

  it("forgets cancelled rows after a week", async () => {
    let at = 1_000;
    const queue = chatQueue(sql(), () => at);
    await queue.put([{ id: "c", status: "cancelled", payload: {}, at: 1 }]);
    at += CANCELLED_KEPT_MS + 1;
    await queue.put([{ id: "d", status: "pending", payload: {}, at: 2 }]);
    expect((await queue.rows()).map((row) => row.id)).toEqual(["d"]);
  });
});

describe("chat history mirror", () => {
  it("keeps one row per message, takes the latest write, and pages in time order", async () => {
    const p = ports();
    const append = (messages: unknown[]) => serveHistory({ op: "append", messages }, claims("c"), p);
    await append([{ id: "m2", at: 20, json: "{\"v\":1}" }, { id: "m1", at: 10, json: "{}" }]);
    await append([{ id: "m2", at: 20, json: "{\"v\":2}" }]);
    const first = await (await serveHistory({ op: "page", limit: 1 }, claims("c"), p)).json() as { rows: Array<{ id: string; json: string }>; count: number };
    expect(first).toMatchObject({ count: 2, rows: [{ id: "m1" }] });
    const next = await (await serveHistory({ op: "page", after: "m1", limit: 5 }, claims("c"), p)).json() as { rows: Array<{ id: string; json: string }> };
    expect(next.rows).toEqual([{ id: "m2", at: 20, json: "{\"v\":2}" }]);
    expect((await append([{ id: "big", at: 1, json: "x".repeat(2000 * 1024) }])).status).toBe(400);
  });
});

describe("queue route", () => {
  it("restores every chat's rows and the dog's slots, and releases a slot's started rows", async () => {
    const p = ports();
    await op(p, "chat-1", { op: "put", rows: [{ id: "m1", sendId: "s1", status: "accepted", payload: { text: "hi" }, at: 100 }] });
    await op(p, "chat-2", { op: "put", rows: [{ id: "q1", status: "pending", payload: { text: "later" }, at: 101 }] });
    await op(p, "chat-1", { op: "slots", slots: [{ chat: "chat-1", since: 100 }], at: 100 });
    let restored = await op(p, "chat-1", { op: "restore" });
    expect(restored.slots).toEqual([{ chat: "chat-1", since: 100 }]);
    expect(Object.keys(restored.chats).sort()).toEqual(["chat-1", "chat-2"]);
    expect(await op(p, "chat-1", { op: "slots", slots: [], at: 150 })).toMatchObject({ released: ["chat-1"], cleared: 1 });
    restored = await op(p, "chat-1", { op: "restore" });
    expect(restored.chats).toEqual({ "chat-2": [{ id: "q1", sendId: null, status: "pending", payload: { text: "later" }, at: 101 }] });
  });

  it("refuses rows it cannot store and unknown operations", async () => {
    const p = ports();
    expect((await serveQueue({ op: "put", rows: [{ id: "bad id", status: "pending", payload: {}, at: 1 }] }, claims("c"), p)).status).toBe(400);
    expect((await serveQueue({ op: "settle", ids: ["a"], status: "done" }, claims("c"), p)).status).toBe(400);
    expect((await serveQueue({ op: "drop" }, claims("c"), p)).status).toBe(400);
  });

  it("answers only the container's turns kind", async () => {
    const p = ports();
    const request = (kind: Claims["kind"]) => new Request("https://home/api/internal/coordinator/queue", {
      method: "POST",
      headers: { [CAPABILITY_CLAIMS_HEADER]: JSON.stringify(claims("c", kind)) },
      body: JSON.stringify({ op: "restore" }),
    });
    const noDogs = () => { throw new Error("unused"); };
    expect((await coordinate(request("agents"), noDogs, undefined, p)).status).toBe(403);
    expect((await coordinate(request("turns"), noDogs, undefined, p)).status).toBe(200);
  });
});
