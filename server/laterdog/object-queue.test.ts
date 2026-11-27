import { describe, expect, it } from "vitest";
import { verifyCapabilitySync, capabilitySecret } from "./signed-capability-node.ts";
import { ObjectQueue, QUEUE_ROUTE, reconcileRow, slotsByDog, type LocalChatView } from "./object-queue.ts";

const home = "hfeedfacecafe";
const bootstrapSecret = "queue-secret";

function fakeCoordinator(failFirst = 0) {
  const calls: Array<{ chat: string; body: Record<string, unknown> }> = [];
  let failures = failFirst;
  const fetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe(`https://home${QUEUE_ROUTE}`);
    const token = String((init.headers as Record<string, string>).authorization).slice("Bearer ".length);
    const check = verifyCapabilitySync(capabilitySecret(bootstrapSecret), token, { home, now: Date.now(), kinds: ["turns"] });
    if (!check.ok) return Response.json({ error: "capability" }, { status: 401 });
    if (failures > 0) { failures -= 1; return Response.json({ error: "coordinator_unavailable" }, { status: 503 }); }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ chat: check.claims.chat, body });
    if (body.op === "restore") return Response.json({ ok: true, slots: [{ chat: "c1", since: 5 }], chats: { c1: [] } });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { calls, fetch };
}

describe("object queue client", () => {
  it("sends one dog's writes in order, retrying through an unavailable coordinator", async () => {
    const coordinator = fakeCoordinator(2);
    const waits: number[] = [];
    const queue = new ObjectQueue({ origin: "https://home", home, bootstrapSecret, fetch: coordinator.fetch, wait: async (ms) => { waits.push(ms); } });
    queue.put("dog", "c1", [{ id: "q1", status: "pending", payload: { text: "one" }, at: 1 }]);
    queue.put("dog", "c1", [{ id: "q2", status: "pending", payload: { text: "two" }, at: 2 }]);
    queue.settle("dog", "c1", ["q1"], "dispatching");
    queue.slots("dog", [{ chat: "c1", since: 3 }]);
    await queue.idle();
    expect(coordinator.calls.map((call) => [call.chat, call.body.op, (call.body.rows as Array<{ id: string }> | undefined)?.[0]?.id ?? call.body.ids ?? call.body.slots])).toEqual([
      ["c1", "put", "q1"], ["c1", "put", "q2"], ["c1", "settle", ["q1"]], ["dog", "slots", [{ chat: "c1", since: 3 }]],
    ]);
    expect(waits).toEqual([500, 1_000]);
    expect(queue.pending()).toBe(0);
  });

  it("restores a dog's slots and rows, and says null when the coordinator cannot answer", async () => {
    const ok = new ObjectQueue({ origin: "https://home", home, bootstrapSecret, fetch: fakeCoordinator().fetch });
    expect(await ok.restore("dog")).toEqual({ slots: [{ chat: "c1", since: 5 }], chats: { c1: [] } });
    const down = new ObjectQueue({ origin: "https://home", home, bootstrapSecret, fetch: (async () => { throw new Error("down"); }) as typeof fetch, log: () => {} });
    expect(await down.restore("dog", 50)).toBeNull();
  });
});

describe("reconciling the object's rows after a restart", () => {
  const view = (overrides: Partial<LocalChatView> = {}): LocalChatView => ({ owned: true, delivered: () => false, localStatus: () => null, ...overrides });

  it("puts back a message the restart lost, wherever it was", () => {
    for (const status of ["accepted", "pending", "dispatching", "interrupted"] as const) {
      expect(reconcileRow({ id: "a", sendId: "s", status }, view())).toEqual({ kind: "requeue" });
    }
  });

  it("drops what the chat already holds and leaves what is still queued here", () => {
    expect(reconcileRow({ id: "a", sendId: "s", status: "accepted" }, view({ delivered: (row) => row.sendId === "s" }))).toEqual({ kind: "drop", status: null });
    expect(reconcileRow({ id: "a", sendId: null, status: "pending" }, view({ localStatus: () => "pending" }))).toEqual({ kind: "keep" });
    expect(reconcileRow({ id: "a", sendId: null, status: "pending" }, view({ localStatus: () => "cancelled" }))).toEqual({ kind: "drop", status: "cancelled" });
    expect(reconcileRow({ id: "a", sendId: null, status: "pending" }, view({ owned: false }))).toEqual({ kind: "drop", status: "cancelled" });
  });

  it("cancels here what was cancelled after the last save", () => {
    expect(reconcileRow({ id: "a", sendId: null, status: "cancelled" }, view({ localStatus: () => "pending" }))).toEqual({ kind: "cancel-here" });
    expect(reconcileRow({ id: "a", sendId: null, status: "cancelled" }, view())).toEqual({ kind: "keep" });
  });

  it("groups running turns into each dog's slots", () => {
    expect([...slotsByDog([{ botId: "d1", threadId: "c1", since: 1 }, { botId: "d2", threadId: "c2", since: 2, planned: true }])]).toEqual([
      ["d1", [{ chat: "c1", since: 1 }]], ["d2", [{ chat: "c2", since: 2, planned: true }]],
    ]);
  });
});
