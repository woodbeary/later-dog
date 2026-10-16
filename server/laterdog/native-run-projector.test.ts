import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeActor, NativeObservation } from "../../shared/native-runs.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { NativeRunProjector } from "./native-run-projector.ts";
import { deleteNativeRuns, ensureNativeRuns, nativeRunLimits, NativeRunStore } from "./native-run-store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
let sequence = 0;
const actor = (id: string, state: NativeActor["state"] = "running"): NativeActor => ({ id, parentId: "parent", kind: "subagent", label: id, state, startedAt: 1000, generation: "run-1", canStop: true });
const event = (data: Omit<RuntimeEvent, "eventId" | "threadId" | "provider" | "createdAt"> & { type: RuntimeEvent["type"] }): RuntimeEvent => ({ eventId: `e-${++sequence}`, threadId: "chat", provider: "codex", providerInstanceId: "account-a", createdAt: "2026-10-16T10:00:00Z", turnId: "turn-1", ...data }) as RuntimeEvent;
const observed = (observation: NativeObservation): RuntimeEvent => event({ type: "native.observed", observation } as RuntimeEvent);

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  ensureNativeRuns(database);
  const access = {
    read: <T>(fn: (database: DatabaseSync) => T): T => fn(database),
    write: <T>(fn: (database: DatabaseSync) => T): T => {
      database.exec("BEGIN IMMEDIATE");
      try { const value = fn(database); database.exec("COMMIT"); return value; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
  const store = new NativeRunStore(access);
  const published: unknown[] = [];
  const projector = new NativeRunProjector(store, run => published.push(structuredClone(run)), () => ({ botId: "speaker", label: "Scout" }));
  return { database, access, store, projector, published };
}

describe("durable native execution", () => {
  it("uses evidenced current activity and prioritizes requests without treating ambient watchers as active work", () => {
    const { projector, store } = fixture();
    projector.observe(event({ type: "turn.started" }));
    projector.observe(observed({ kind: "actor", actor: { ...actor("watcher"), ambient: true } }));
    expect(projector.running("chat")).toBe(false);
    projector.observe(observed({ kind: "activity", activity: { id: "request", actorId: "parent", kind: "request", label: "Approval needed", state: "waiting", startedAt: 1 } }));
    const run = projector.observe(observed({ kind: "activity", activity: { id: "search", actorId: "parent", kind: "search", label: "Search docs", state: "running", startedAt: 2 } }))!;
    expect(run.currentActivity).toMatchObject({ id: "request", state: "waiting" });
    projector.observe(observed({ kind: "activity", activity: { id: "request", actorId: "parent", kind: "request", label: "Allowed", state: "done", startedAt: 1 } }));
    expect(store.get(run.id)?.currentActivity).toMatchObject({ id: "search", kind: "search" });
    const finished = projector.observe(event({ type: "turn.completed", ok: true } as RuntimeEvent))!;
    expect(finished.observation).toBe("complete");
    expect(finished.currentActivity).toBeUndefined();
  });

  it("reconciles incomplete history when a late native completion is observed", () => {
    const { projector } = fixture();
    projector.observe(observed({ kind: "actor", actor: actor("child") }));
    expect(projector.observe(event({ type: "turn.completed", ok: true } as RuntimeEvent))!.observation).toBe("partial");
    expect(projector.observe(observed({ kind: "actor", actor: actor("child", "done") }))!.observation).toBe("complete");
  });

  it("keeps a paused helper discoverable as unfinished when its parent completes", () => {
    const { projector } = fixture();
    projector.observe(observed({ kind: "actor", actor: actor("child", "paused") }));
    const run = projector.observe(event({ type: "turn.completed", ok: true } as RuntimeEvent))!;
    expect(run.observation).toBe("partial");
    expect(run.actors.find(actor => actor.id === "child")).toMatchObject({ state: "paused", canStop: false });
    expect(projector.running("chat")).toBe(false);
  });
  it("retains nested actors and results after a parent finishes and another turn starts", () => {
    const { projector, store } = fixture();
    projector.observe(event({ type: "turn.started" }));
    projector.observe(observed({ kind: "actor", actor: actor("child") }));
    projector.observe(observed({ kind: "actor", actor: { ...actor("grandchild"), parentId: "child" } }));
    projector.observe(observed({ kind: "activity", activity: { id: "search", actorId: "grandchild", kind: "search", label: "Search", state: "done", startedAt: 1001, output: "Found it", links: [{ title: "Docs", url: "https://example.org" }] } }));
    projector.observe(observed({ kind: "actor", actor: { ...actor("grandchild", "done"), parentId: "child", summary: "Found the answer" } }));
    projector.observe(observed({ kind: "actor", actor: actor("child", "done") }));
    const finished = projector.observe(event({ type: "turn.completed", ok: true } as RuntimeEvent))!;
    projector.observe({ ...event({ type: "turn.started" }), turnId: "turn-2", createdAt: "2026-10-16T10:01:00Z" });
    const restored = store.detail("chat", finished.id)!;
    expect(restored.run).toMatchObject({ state: "done", observation: "complete", botId: "speaker", activityCount: 1 });
    expect(restored.run.actors.find(row => row.id === "grandchild")).toMatchObject({ parentId: "child", summary: "Found the answer" });
    expect(restored.activities[0]).toMatchObject({ actorId: "grandchild", output: "Found it" });
    expect(store.list("chat").runs).toHaveLength(2);
  });

  it("deduplicates deltas atomically and separates native actors with equal item names", () => {
    const { projector, store } = fixture();
    const delta = observed({ kind: "activity", append: "text", activity: { id: "child-a:reply", actorId: "child-a", kind: "message", label: "Reply", state: "running", startedAt: 1, text: "Hello" } });
    const first = projector.observe(delta)!;
    expect(projector.observe(delta)).toBeUndefined();
    projector.observe(observed({ kind: "activity", activity: { id: "child-b:reply", actorId: "child-b", kind: "message", label: "Reply", state: "done", startedAt: 2, text: "Other" } }));
    expect(store.detail("chat", first.id)!.activities.map(row => row.text)).toEqual(["Hello", "Other"]);
    expect(store.get(first.id)!.revision).toBe(2);
  });

  it("accepts a resumed generation while late old events cannot restart a completed actor", () => {
    const { projector } = fixture();
    projector.observe(observed({ kind: "actor", actor: actor("old", "done") }));
    projector.observe(observed({ kind: "actor", actor: actor("old") }));
    const run = projector.observe(observed({ kind: "actor", actor: { ...actor("new"), generation: "run-2", nativeId: "same-task" } }))!;
    expect(run.actors.find(row => row.id === "old")!.state).toBe("done");
    expect(run.actors.find(row => row.id === "new")!.state).toBe("running");
  });

  it("does not let a delayed older turn replace the current run", () => {
    const { projector } = fixture();
    projector.observe(event({ type: "turn.started" }));
    projector.observe({ ...event({ type: "turn.started" }), turnId: "newer", createdAt: "2026-10-16T11:00:00Z" });
    projector.observe(observed({ kind: "actor", actor: actor("late", "done") }));
    expect(projector.current("chat")!.turnId).toBe("newer");
  });

  it("preserves failed child outcomes under a successful parent and unknown completion as partial", () => {
    const { projector } = fixture();
    projector.observe(observed({ kind: "actor", actor: actor("failed", "failed") }));
    projector.observe(observed({ kind: "actor", actor: actor("unknown") }));
    const run = projector.observe(event({ type: "turn.completed", ok: true } as RuntimeEvent))!;
    expect(run).toMatchObject({ state: "done", failureCount: 1, observation: "partial" });
    expect(run.actors.find(row => row.id === "unknown")).toMatchObject({ state: "running", canStop: false });
    expect(projector.running("chat")).toBe(false);
  });

  it("redacts secrets and bounds content before persistence and publication", () => {
    const { projector, store, database, published } = fixture();
    const run = projector.observe(observed({ kind: "activity", activity: { id: "secret", actorId: "parent", kind: "tool", label: "Read", state: "done", startedAt: 1, input: "API_KEY=sk-secret-value-that-must-not-leak", output: "a".repeat(30_000), links: [{ title: "Bad", url: "javascript:alert(1)" }] } }))!;
    const detail = store.detail("chat", run.id)!;
    expect(detail.activities[0]).toMatchObject({ truncated: true, links: [] });
    expect(detail.activities[0].output!.length).toBe(24_000);
    expect(JSON.stringify(database.prepare("SELECT json FROM native_run_events").all())).not.toContain("sk-secret-value-that-must-not-leak");
    expect(JSON.stringify(published)).not.toContain("sk-secret-value-that-must-not-leak");
  });

  it("recovers history without claiming a worker survived a server restart", () => {
    const { projector, access } = fixture();
    const run = projector.observe(observed({ kind: "actor", actor: actor("worker") }))!;
    const reopened = new NativeRunStore(access);
    reopened.recoverInterrupted();
    expect(reopened.detail("chat", run.id)!.run).toMatchObject({ observation: "interrupted", state: "running" });
    expect(reopened.get(run.id)!.actors.every(row => row.canStop === false)).toBe(true);
  });

  it("paginates details, retains a truncation receipt, and deletes only the requested conversation", () => {
    const { projector, store, database } = fixture();
    let id = "";
    for (let n = 0; n < 3; n++) id = projector.observe(observed({ kind: "activity", activity: { id: `item-${n}`, actorId: "parent", kind: "tool", label: "Tool", state: "done", startedAt: n } }))!.id;
    projector.observe(event({ type: "turn.completed", ok: true } as RuntimeEvent));
    const page = store.detail("chat", id, undefined, 2)!;
    expect(page.activities).toHaveLength(2);
    expect(store.detail("chat", id, page.nextCursor, 2)!.activities).toHaveLength(1);
    projector.observe({ ...event({ type: "turn.started" }), threadId: "other" });
    store.pruneDetails(Date.now() + 1000, "chat");
    expect(store.detail("chat", id)).toMatchObject({ run: { truncated: true, activityCount: 3 }, activities: [] });
    deleteNativeRuns(database, "chat");
    expect(store.list("chat").runs).toHaveLength(0);
    expect(store.list("other").runs).toHaveLength(1);
  });

  it("preserves the speaker name when a provider reports its generic parent label", () => {
    const { projector } = fixture();
    const run = projector.observe(observed({ kind: "actor", actor: { id: "parent", kind: "parent", label: "Claude", state: "running", startedAt: 1 } }))!;
    expect(run.actors[0].label).toBe("Scout");
  });

  it("attributes overlapping requests and helpers to their exact provider turn", () => {
    const { projector } = fixture();
    const first = observed({ kind: "actor", actor: { ...actor("same"), label: "First helper" } });
    const second = { ...observed({ kind: "actor", actor: { ...actor("same", "done"), label: "Second helper" } }), providerInstanceId: "account-b", turnId: "turn-2", createdAt: "2026-10-16T11:00:00Z" };
    const firstRun = projector.observe(first)!;
    const secondRun = projector.observe(second)!;
    expect(projector.current("chat")?.id).toBe(secondRun.id);
    expect(projector.forEvent(first)?.id).toBe(firstRun.id);
    expect(projector.forEvent(first)?.actors.find(row => row.id === "same")?.label).toBe("First helper");
    expect(projector.running("chat", first)).toBe(true);
    expect(projector.running("chat", second)).toBe(false);
    expect(projector.running("chat")).toBe(true);
    expect(projector.snapshot(() => true).helpers.chat.map(row => row.label)).toEqual(expect.arrayContaining(["First helper", "Second helper"]));
    projector.interrupt("chat", "Connection lost");
    expect(projector.running("chat")).toBe(false);
  });

  it("deduplicates arbitrarily old ordered deltas without retaining per-token events", () => {
    const { projector, store, database } = fixture();
    const delta = { ...observed({ kind: "activity", append: "text", activity: { id: "reply", actorId: "parent", kind: "message", label: "Reply", state: "running", startedAt: 1, text: "x" } }), nativeSequence: 1 };
    const run = projector.observe(delta)!;
    for (let nativeSequence = 2; nativeSequence <= 6_000; nativeSequence++) projector.observe({ ...delta, eventId: `ordered-${nativeSequence}`, nativeSequence });
    expect(projector.observe(delta)).toBeUndefined();
    expect(store.detail("chat", run.id)?.activities[0].text).toHaveLength(6_000);
    expect(database.prepare("SELECT COUNT(*) AS count FROM native_run_events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT event_sequence FROM native_runs WHERE id = ?").get(run.id)).toEqual({ event_sequence: 6_000 });
  });

  it("bounds legacy deduplication and marks missing observations while retaining completion", () => {
    const { projector, store, database } = fixture();
    let run;
    for (let n = 0; n <= nativeRunLimits.legacyEvents; n++) run = projector.observe(event({ type: "turn.started" })) ?? run;
    expect(run).toMatchObject({ truncated: true, limitations: ["This harness reached the legacy event recording limit."] });
    expect(database.prepare("SELECT COUNT(*) AS count FROM native_run_events").get()).toEqual({ count: nativeRunLimits.legacyEvents });
    const completed = projector.observe(event({ type: "turn.completed", ok: true } as RuntimeEvent))!;
    expect(completed.state).toBe("done");
    store.pruneDetails(Date.now(), "chat");
    expect(database.prepare("SELECT COUNT(*) AS count FROM native_run_events").get()).toEqual({ count: 0 });
    expect(projector.observe(event({ type: "turn.started" }))).toBeUndefined();
    expect(store.get(completed.id)?.state).toBe("done");
  });

  it("bounds detail bytes and reports shortened history without retaining raw payload copies", () => {
    const { projector, store, database } = fixture();
    let run;
    for (let n = 0; n < 100; n++) run = projector.observe({ ...observed({ kind: "activity", activity: { id: `large-${n}`, actorId: "parent", kind: "tool", label: "Read", state: "done", startedAt: n, output: "x".repeat(24_000) } }), nativeSequence: n + 1 })!;
    const size = database.prepare("SELECT SUM(length(CAST(json AS BLOB))) AS bytes FROM native_run_items").get() as { bytes: number };
    expect(size.bytes).toBeLessThanOrEqual(nativeRunLimits.detailBytes);
    expect(store.get(run!.id)).toMatchObject({ truncated: true, activityCount: 100 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM native_run_events").get()).toEqual({ count: 0 });
  });

  it("bounds completed receipts and makes removed cursors explicit without deleting live work", () => {
    const { projector, store, database } = fixture();
    const live = projector.observe(event({ type: "turn.started" }))!;
    let first = "";
    for (let n = 0; n <= nativeRunLimits.receipts; n++) {
      const run = projector.observe({ ...event({ type: "turn.completed", ok: true } as RuntimeEvent), turnId: `receipt-${n}`, createdAt: new Date(1_000 + n).toISOString(), nativeSequence: n + 1 })!;
      if (n === 0) first = run.id;
    }
    expect(store.get(live.id)?.observation).toBe("live");
    expect(store.get(first)).toBeUndefined();
    expect(store.list("chat")).toMatchObject({ historyIncomplete: true });
    expect(store.list("chat", first)).toEqual({ runs: [], historyIncomplete: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM native_runs").get()).toEqual({ count: nativeRunLimits.receipts + 1 });
  });

  it("rolls back event insertion if projection fails", () => {
    const { store, database } = fixture();
    expect(() => store.apply("bad", "once", 0, {}, () => { throw new Error("storage"); })).toThrow("storage");
    expect(database.prepare("SELECT COUNT(*) AS count FROM native_run_events").get()).toEqual({ count: 0 });
  });
});
