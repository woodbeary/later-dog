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

const { admitAtEdge, homeAdmission, sha256Hex, ARRIVAL_LEASE_MS } = await import("../src/edge-admission.ts");
const { coordinate } = await import("../src/coordinator.ts");
const { CAPABILITY_CLAIMS_HEADER } = await import("../src/edge-routes.ts");

const HOME = "h0123456789abcdef01234567";
const TOKEN = "laterdog_sess_owner-token-for-tests";

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

async function setup(now = () => 1_000_000) {
  const admission = homeAdmission(sql(), memoryStorage(), now);
  await admission.configure({ dogs: ["dog-1"], sessions: [
    { hash: await sha256Hex(TOKEN), id: "s-owner", scopes: ["admin"], expiresAt: 2_000_000 },
    { hash: await sha256Hex("laterdog_sess_guest"), id: "s-guest", scopes: ["client"], expiresAt: 2_000_000 },
  ] });
  const coordinator = { fetch: (request: Request) => coordinate(request, () => { throw new Error("unused"); }, undefined, undefined, undefined, () => admission) };
  return { admission, coordinator };
}

const send = (body: Record<string, unknown>, token = TOKEN, dog = "dog-1") => new Request(`https://${HOME}-home.later.dog/api/bots/${dog}/messages`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const plain = { text: "hello", threadId: "chat-1", sendId: "send-0123456789abcdef" };

describe("admission at the edge", () => {
  it("accepts an owner's plain send without the home, once per send id, in order", async () => {
    const { admission, coordinator } = await setup();
    const deps = { enabled: true, home: HOME, coordinator, claimsHeader: CAPABILITY_CLAIMS_HEADER, now: () => 1_000_000 };
    const first = await admitAtEdge(send(plain), deps);
    expect(first?.status).toBe(202);
    expect(await first?.json()).toEqual({ ok: true, queued: true, queueId: "e-send-0123456789abcdef", threadId: "chat-1", admitted: "edge" });
    expect((await admitAtEdge(send(plain), deps))?.status).toBe(202);
    await admitAtEdge(send({ ...plain, sendId: "send-1123456789abcdef", text: "second" }), deps);
    const taken = await admission.take(10);
    expect(taken.map((arrival) => [arrival.id, arrival.session, arrival.body.text])).toEqual([["e-send-0123456789abcdef", "s-owner", "hello"], ["e-send-1123456789abcdef", "s-owner", "second"]]);
    expect(await admission.take(10)).toEqual([]);
    await admission.done([taken[0]!.id]);
  });

  it("leaves everything else to the home", async () => {
    const { coordinator } = await setup();
    const deps = { enabled: true, home: HOME, coordinator, claimsHeader: CAPABILITY_CLAIMS_HEADER, now: () => 1_000_000 };
    expect(await admitAtEdge(send(plain, "laterdog_sess_unknown"), deps)).toBeNull();
    expect(await admitAtEdge(send(plain, "laterdog_sess_guest"), deps)).toBeNull();
    expect(await admitAtEdge(send(plain, TOKEN, "dog-2"), deps)).toBeNull();
    expect(await admitAtEdge(send({ ...plain, deskReply: {} }), deps)).toBeNull();
    expect(await admitAtEdge(send({ ...plain, sendId: undefined }), deps)).toBeNull();
    expect(await admitAtEdge(send({ ...plain, deliver: "stop" }), deps)).toBeNull();
    expect(await admitAtEdge(send(plain), { ...deps, enabled: false })).toBeNull();
    expect(await admitAtEdge(new Request(`https://${HOME}-home.later.dog/api/bots/dog-1/messages/guarded`, { method: "POST", body: "{}" }), deps)).toBeNull();
    expect(await admitAtEdge(send(plain), { ...deps, coordinator: { fetch: async () => { throw new Error("down"); } } })).toBeNull();
  });

  it("offers a taken arrival again when the home never confirms it", async () => {
    let at = 1_000_000;
    const { admission, coordinator } = await setup(() => at);
    await admitAtEdge(send(plain), { enabled: true, home: HOME, coordinator, claimsHeader: CAPABILITY_CLAIMS_HEADER, now: () => at });
    expect((await admission.take(10)).length).toBe(1);
    at += ARRIVAL_LEASE_MS + 1;
    expect((await admission.take(10)).length).toBe(1);
  });

  it("serves admission only to the container's kind and the edge's own claims", async () => {
    const { coordinator } = await setup();
    const call = (path: string, claims: Record<string, unknown>, body: unknown) => coordinator.fetch(new Request(`https://coordinator${path}`, {
      method: "POST", headers: { [CAPABILITY_CLAIMS_HEADER]: JSON.stringify({ home: HOME, dog: "dog-1", chat: "chat-1", issuedAt: 1, expiresAt: Date.now() + 60_000, ...claims }) }, body: JSON.stringify(body),
    }));
    expect((await call("/api/internal/coordinator/admit", { generation: "queue", kind: "turns" }, { hash: "x", body: plain })).status).toBe(403);
    expect((await call("/api/internal/coordinator/admission", { generation: "admission", kind: "agents" }, { op: "take" })).status).toBe(403);
    expect((await call("/api/internal/coordinator/admission", { generation: "admission", kind: "turns" }, { op: "take" })).status).toBe(200);
  });
});
