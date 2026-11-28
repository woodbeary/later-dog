import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { initializeHistoryShard } from "../../deploy/laterdog/home/src/history-schema.ts";
import { executeHistoryNativeOperation, type NativeHistoryOperation } from "../../shared/history-native-operations.ts";
import type { HistorySql } from "../../shared/history-values.ts";
import type { NativeProjectionEvent } from "../../shared/native-run-projection.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { NativeRunProjector } from "./native-run-projector.ts";
import { NativeRunStore, type NativeRunDatabase } from "./native-run-store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  let next = 9_007_199_254_741_003n;
  const sql: HistorySql = {
    exec<T>(query: string, ...args: Array<string | number | null | ArrayBuffer>): T[] {
      return db.prepare(query).all(...args.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value)) as T[];
    },
  };
  initializeHistoryShard(sql);
  const calls: Array<[string, string]> = [];
  const execute = <T>(thread: string, op: NativeHistoryOperation): T => {
    calls.push([thread, op.op]);
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = executeHistoryNativeOperation(sql, thread, JSON.parse(JSON.stringify(op)), () => String(next++));
      db.exec("COMMIT");
      return result as T;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const history: NonNullable<NativeRunDatabase["history"]> = { enabled: () => true, execute,
    many: <T>(threads: readonly string[] | undefined, op: NativeHistoryOperation) => (threads ?? ["thread", "other"]).map(threadId => ({ threadId, result: execute<T>(threadId, op) })) };
  const noLocal = (): never => { throw Error("Local activity storage was accessed"); };
  const store = new NativeRunStore({ read: noLocal, write: noLocal, history });
  return { db, store, calls, projector: new NativeRunProjector(store, () => {}) };
}

describe("native activity on a conversation history shard", () => {
  it("projects each ordered event on its thread, reopens a previous receipt and fences duplicates and stale interruptions", () => {
    const { store, calls, projector, db } = fixture();
    const common = { threadId: "thread", provider: "codex", providerInstanceId: "one", turnId: "turn", createdAt: "2026-11-24T00:00:00Z" };
    const start = projector.observe({ ...common, eventId: "one", type: "turn.started", nativeSequence: 1 } as RuntimeEvent)!;
    const event = { ...common, eventId: "two", type: "native.observed", nativeSequence: 2, observation: { kind: "activity", activity: { id: "read", actorId: "parent", kind: "tool", label: "Read", state: "running", startedAt: 8 } } } as RuntimeEvent;
    const run = projector.observe(event)!;
    expect(projector.observe(event)).toBeUndefined();
    expect(store.interrupt("thread", start.id, start.revision, 20, "Old process")).toBeUndefined();
    expect(store.detail("other", run.id)).toBeUndefined();
    expect(store.get(run.id, "other")).toBeUndefined();
    expect(new NativeRunProjector(store, () => {}).current("thread")).toEqual(run);
    expect(store.detail("thread", run.id)?.activities).toHaveLength(1);
    expect(store.list("other", run.id)).toEqual({ runs: [], historyIncomplete: true });
    const before = db.prepare("SELECT CAST(rowid AS TEXT) AS id FROM native_runs").get();
    expect(BigInt(String(before!.id))).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    store.recoverInterrupted(100);
    expect(store.get(run.id, "thread")).toMatchObject({ observation: "interrupted", state: "stopped" });
    expect(db.prepare("SELECT CAST(rowid AS TEXT) AS id FROM native_runs").get()).toEqual(before);
    expect(projector.observe({ ...event, eventId: "three", nativeSequence: 3 } as RuntimeEvent)).toBeUndefined();
    expect(calls).toContainEqual(["other", "native.recover"]);
  });

  it("paginates large completed and live activity by its logical size and retains each run", () => {
    const { store, calls } = fixture();
    const model = "界".repeat(400_000);
    for (const id of ["one", "two", "three"]) {
      store.observe("thread", { id, turnId: id, provider: "codex", eventId: id, at: id.length, type: "native.observed",
        observation: { kind: "actor", actor: { id: "helper", kind: "subagent", label: id, state: "running", startedAt: 1, model } } });
    }
    const first = store.list("thread", undefined, 100);
    expect(first.runs.map(run => run.id)).toEqual(["three"]);
    expect(first.nextCursor).toBe("three");
    const second = store.list("thread", first.nextCursor, 100);
    expect(second.runs.map(run => run.id)).toEqual(["two"]);
    const last = store.list("thread", second.nextCursor, 100);
    expect(last.runs.map(run => run.id)).toEqual(["one"]);
    expect(last.nextCursor).toBeUndefined();
    expect(store.live("thread").map(run => run.id)).toEqual(["three", "two", "one"]);
    expect(calls.filter(([, op]) => op === "native.livePage")).toHaveLength(3);
  });

  it("retains oversized actors and activity and counts their real bytes while evicting and pruning", () => {
    const { db, store } = fixture();
    const common = { id: "run", turnId: "turn", provider: "claude", at: 100, type: "native.observed" } as const;
    const event = (id: string, observation: NativeProjectionEvent["observation"]) => store.observe("thread", { ...common, eventId: id, observation });
    const large = "界".repeat(720_000);
    event("actor", { kind: "actor", actor: { id: "child", kind: "subagent", label: "Explore", state: "running", startedAt: 90, model: large } });
    expect(store.get("run", "thread")!.actors[1].model).toBe(large);
    const item = { actorId: "child", kind: "tool", label: "Read", state: "done", startedAt: 98 } as const;
    const text = "界".repeat(390_000);
    event("first", { kind: "activity", activity: { ...item, id: "first", text } });
    const first = db.prepare("SELECT CAST(rowid AS TEXT) AS rid FROM native_run_items WHERE id='first'").get()!.rid;
    expect(store.detail("thread", "run")!.activities[0].text).toBe(text);
    event("second", { kind: "activity", activity: { ...item, id: "second", text } });
    expect(store.detail("thread", "run")!.activities.map(a => a.id)).toEqual(["second"]);
    expect(db.prepare("SELECT 1 FROM history_values WHERE relation='native_run_items' AND entry=?").get(first)).toBeUndefined();
    const second = db.prepare("SELECT CAST(rowid AS TEXT) AS rid FROM native_run_items WHERE id='second'").get();
    event("updated", { kind: "activity", activity: { ...item, id: "second", text: text + "updated" } });
    expect(db.prepare("SELECT CAST(rowid AS TEXT) AS rid FROM native_run_items WHERE id='second'").get()).toEqual(second);
    expect(store.detail("thread", "run")!.activities[0].text).toBe(text+"updated");
    expect(db.prepare("SELECT COUNT(*) AS n FROM native_run_events").get()?.n).toBe(4);
    expect(event("updated", { kind: "capabilities", limitations: [] })).toBeUndefined();
    store.recoverInterrupted(400);
    store.pruneDetails(500, "thread");
    expect(store.detail("thread", "run")).toMatchObject({ run: { truncated: true }, activities: [] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM history_values").get()?.n).toBe(0);
  });
});
