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

const { dogRoutines } = await import("../src/dog-routines.ts");
const { dogInbox } = await import("../src/dog-inbox.ts");
const { coordinate } = await import("../src/coordinator.ts");
const { CAPABILITY_CLAIMS_HEADER } = await import("../src/edge-routes.ts");
const { ROUTINES_ROUTE, INBOX_ROUTE } = await import("../../../../shared/dog-object-protocol.ts");
type Claims = import("../../../../shared/signed-capability.ts").SignedCapabilityClaims;
type Letter = import("../../../../shared/dog-object-protocol.ts").InboxLetter;

const HOME = "h0123456789abcdef01234567";
const MINUTE = 60_000;
const START = Date.parse("2026-11-27T18:00:00Z");

function sql(database = new DatabaseSync(":memory:")) {
  return {
    exec: (query: string, ...bindings: unknown[]) => {
      const rows = database.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}

function harness() {
  const database = new DatabaseSync(":memory:");
  const clock = { now: START };
  const alarm = { at: null as number | null, async set(at: number) { alarm.at = at; }, async clear() { alarm.at = null; } };
  const open = () => dogRoutines(sql(database), alarm, () => clock.now);
  return { clock, alarm, open, routines: open() };
}

const every10 = { type: "interval" as const, everyMinutes: 10, anchorAt: START };

describe("routines in the dog object", () => {
  it("arms one alarm for the earliest run and fires each occurrence once", async () => {
    const h = harness();
    await h.routines.putRoutines("America/Los_Angeles", [{ id: "r1", schedule: every10, nextRunAt: START + 10 * MINUTE, enabled: true }]);
    expect(h.alarm.at).toBe(START + 10 * MINUTE);
    h.clock.now = START + 10 * MINUTE + 500;
    expect(await h.routines.fireRoutines()).toBe(1);
    expect(await h.routines.fireRoutines()).toBe(0);
    const claimed = await h.routines.claimRoutines();
    expect(claimed.occurrences).toEqual([expect.objectContaining({ id: `r1-at-${START + 10 * MINUTE}`, state: "due", missed: false, nextRunAt: START + 20 * MINUTE })]);
    expect(h.alarm.at).toBe(START + 20 * MINUTE);
  });

  it("keeps occurrences and its own next run through a restart of the object and a stale push from the home", async () => {
    const h = harness();
    await h.routines.putRoutines("UTC", [{ id: "r1", schedule: every10, nextRunAt: START + 10 * MINUTE, enabled: true }]);
    h.clock.now = START + 10 * MINUTE;
    await h.routines.fireRoutines();
    const reopened = h.open();
    const after = await reopened.putRoutines("UTC", [{ id: "r1", schedule: every10, nextRunAt: START + 10 * MINUTE, enabled: true }]);
    expect(after.schedules).toEqual([{ id: "r1", nextRunAt: START + 20 * MINUTE, enabled: true }]);
    expect(after.occurrences.map((occurrence) => occurrence.id)).toEqual([`r1-at-${START + 10 * MINUTE}`]);
  });

  it("moves an occurrence from due to started to settled, never back, and only for its run", async () => {
    const h = harness();
    await h.routines.putRoutines("UTC", [{ id: "r1", schedule: every10, nextRunAt: START, enabled: true }]);
    const [occurrence] = (await h.routines.claimRoutines()).occurrences;
    expect(await h.routines.settleRoutine(occurrence!.id, "started", "run-a")).not.toBeNull();
    expect(await h.routines.settleRoutine(occurrence!.id, "started", "run-b")).toBeNull();
    await h.routines.settleRoutine(occurrence!.id, "settled", "run-a");
    await h.routines.settleRoutine(occurrence!.id, "started", "run-a");
    expect((await h.routines.claimRoutines()).occurrences).toEqual([]);
  });

  it("takes the home's next run when a schedule changes, disables a one-off after it fires and marks long-late runs missed", async () => {
    const h = harness();
    await h.routines.putRoutines("UTC", [
      { id: "once", schedule: { type: "once", at: START - 13 * 60 * MINUTE }, nextRunAt: START - 13 * 60 * MINUTE, enabled: true },
      { id: "r1", schedule: every10, nextRunAt: START + 10 * MINUTE, enabled: true },
    ]);
    const claimed = await h.routines.claimRoutines();
    expect(claimed.occurrences).toEqual([expect.objectContaining({ routineId: "once", missed: true })]);
    expect(claimed.schedules).toContainEqual({ id: "once", nextRunAt: null, enabled: false });
    const changed = { ...every10, everyMinutes: 30 };
    const moved = await h.routines.putRoutines("UTC", [{ id: "r1", schedule: changed, nextRunAt: START + 30 * MINUTE, enabled: true }]);
    expect(moved.schedules).toEqual([{ id: "r1", nextRunAt: START + 30 * MINUTE, enabled: true }]);
    expect(h.alarm.at).toBe(START + 30 * MINUTE);
  });

  it("exports its rows and stops its alarm when the dog goes back to the home's scheduler", async () => {
    const h = harness();
    await h.routines.putRoutines("UTC", [{ id: "r1", schedule: every10, nextRunAt: START + 10 * MINUTE, enabled: true }]);
    const exported = await h.routines.exportRoutines();
    expect(exported.schedules).toEqual([{ id: "r1", nextRunAt: START + 10 * MINUTE, enabled: true }]);
    expect(h.alarm.at).toBeNull();
    expect((await h.routines.claimRoutines()).schedules).toEqual([]);
  });

  it("fires a daily routine at the home's wall time", async () => {
    const h = harness();
    const nine = Date.parse("2026-11-28T17:00:00Z");
    await h.routines.putRoutines("America/Los_Angeles", [{ id: "d", schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, nextRunAt: nine, enabled: true }]);
    h.clock.now = nine + 1_000;
    await h.routines.fireRoutines();
    expect((await h.routines.claimRoutines()).schedules).toEqual([{ id: "d", nextRunAt: nine + 24 * 60 * MINUTE, enabled: true }]);
  });
});

const letter = (clientId: string, from = "dog-a", text = clientId): Letter => ({ clientId, from, fromChat: "chat-a", toChat: null, text, replyTo: null, at: START });

describe("the dog inbox", () => {
  it("stores each letter once per client id and hands them out in arrival order until acknowledged", async () => {
    const database = new DatabaseSync(":memory:");
    const inbox = dogInbox(sql(database), () => START);
    const first = await inbox.inboxPut(letter("m1"));
    expect(await inbox.inboxPut(letter("m1", "dog-a", "changed"))).toEqual(first);
    await inbox.inboxPut(letter("m2"));
    await inbox.inboxPut(letter("m3", "dog-b"));
    expect((await inbox.inboxPull(0, 10)).map((stored) => stored.clientId)).toEqual(["m1", "m2", "m3"]);
    expect(await inbox.inboxAck(["m1", "m1"])).toBe(1);
    const reopened = dogInbox(sql(database), () => START);
    expect((await reopened.inboxPull(0, 10)).map((stored) => stored.clientId)).toEqual(["m2", "m3"]);
    expect(await reopened.inboxStatus(["m1", "m2", "zz"])).toEqual({ m1: "delivered", m2: "accepted" });
  });
});

describe("dog object routes", () => {
  const claims = (dog: string, chat = "dog", kind: Claims["kind"] = "turns"): Claims => ({ home: HOME, dog, chat, generation: "g", kind, issuedAt: 1, expiresAt: Date.now() + 60_000 });
  const objects = new Map<string, ReturnType<typeof dogRoutines> & ReturnType<typeof dogInbox>>();
  const dogFor = (home: string, dog: string) => {
    const key = `${home}/${dog}`;
    if (!objects.has(key)) {
      const db = sql();
      objects.set(key, { ...dogRoutines(db, { async set() {}, async clear() {} }), ...dogInbox(db) });
    }
    return objects.get(key)!;
  };
  const call = (path: string, who: Claims, body: unknown) => coordinate(
    new Request(`https://x${path}`, { method: "POST", headers: { [CAPABILITY_CLAIMS_HEADER]: JSON.stringify(who) }, body: JSON.stringify(body) }),
    () => { throw new Error("unused"); },
    undefined,
    undefined,
    dogFor,
  );

  it("refuses a letter that claims another sender and lets only the owner pull its inbox", async () => {
    expect((await call(INBOX_ROUTE, claims("dog-a", "chat-a"), { op: "put", dog: "dog-b", letter: letter("x1", "dog-c") })).status).toBe(400);
    expect((await call(INBOX_ROUTE, claims("dog-a", "chat-a"), { op: "put", dog: "dog-b", letter: letter("x1") })).status).toBe(200);
    expect((await call(INBOX_ROUTE, claims("dog-b", "chat-b"), { op: "pull" })).status).toBe(403);
    const pulled = await (await call(INBOX_ROUTE, claims("dog-b"), { op: "pull" })).json() as { letters: Array<{ clientId: string }> };
    expect(pulled.letters.map((stored) => stored.clientId)).toEqual(["x1"]);
    const status = await (await call(INBOX_ROUTE, claims("dog-a", "chat-a"), { op: "status", dog: "dog-b", clientIds: ["x1"] })).json();
    expect(status).toEqual({ ok: true, states: { x1: "accepted" } });
  });

  it("serves routines only to a dog-level capability of the turns kind", async () => {
    expect((await call(ROUTINES_ROUTE, claims("dog-a", "chat-a"), { op: "claim" })).status).toBe(403);
    expect((await call(ROUTINES_ROUTE, claims("dog-a", "dog", "index"), { op: "claim" })).status).toBe(403);
    expect((await call(ROUTINES_ROUTE, claims("dog-a"), { op: "put", timeZone: "UTC", routines: [{ id: "r", schedule: { type: "bogus" }, nextRunAt: 1, enabled: true }] })).status).toBe(400);
    const put = await call(ROUTINES_ROUTE, claims("dog-a"), { op: "put", timeZone: "UTC", routines: [{ id: "r", schedule: every10, nextRunAt: START, enabled: true }] });
    expect(put.status).toBe(200);
    expect((await call(ROUTINES_ROUTE, claims("dog-a"), { op: "settle", id: "nope", state: "started", runId: "r" })).status).toBe(409);
  });
});
