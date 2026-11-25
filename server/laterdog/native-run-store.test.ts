import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeActivity, NativeObservation } from "../../shared/native-runs.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { NativeRunProjector } from "./native-run-projector.ts";
import { ensureNativeRuns, NativeRunStore } from "./native-run-store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
let sequence = 0;
const ms = (second: number): number => Date.UTC(2026, 10, 16, 10, 0, second);
const event = (second: number, data: Record<string, unknown>): RuntimeEvent => ({ eventId: `e-${++sequence}`, threadId: "chat", provider: "claude", providerInstanceId: "account-a", createdAt: new Date(ms(second)).toISOString(), turnId: "turn-1", ...data }) as RuntimeEvent;
const observed = (second: number, observation: NativeObservation): RuntimeEvent => event(second, { type: "native.observed", observation });
const step = (second: number, id: string, extra: Partial<NativeActivity> = {}): RuntimeEvent => observed(second, { kind: "activity", activity: { id, actorId: "parent", kind: "tool", label: "Read", state: "running", startedAt: ms(second), ...extra } });

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  ensureNativeRuns(database);
  const store = new NativeRunStore({
    read: <T>(fn: (database: DatabaseSync) => T): T => fn(database),
    write: <T>(fn: (database: DatabaseSync) => T): T => {
      database.exec("BEGIN IMMEDIATE");
      try { const value = fn(database); database.exec("COMMIT"); return value; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  });
  const projector = new NativeRunProjector(store, () => undefined);
  return { store, projector };
}

describe("when the current step started", () => {
  it("is sent with the current step and holds while that step stays current", () => {
    const { store, projector } = fixture();
    projector.observe(event(0, { type: "turn.started" }));
    const first = projector.observe(step(1, "read"))!;
    expect(first.currentActivity).toEqual({ id: "read", actorId: "parent", kind: "tool", label: "Read", state: "running", startedAt: ms(1) });
    projector.observe(observed(3, { kind: "activity", append: "output", activity: { id: "read", actorId: "parent", kind: "tool", label: "Read", state: "running", startedAt: ms(3), output: "line" } }));
    expect(store.get(first.id)!.currentActivity).toMatchObject({ id: "read", startedAt: ms(1) });
    projector.observe(step(5, "edit", { label: "Edit" }));
    expect(store.get(first.id)!.currentActivity).toMatchObject({ id: "edit", startedAt: ms(5) });
    projector.observe(step(6, "edit", { label: "Edit", state: "done", endedAt: ms(6) }));
    expect(store.get(first.id)!.currentActivity).toMatchObject({ id: "read", startedAt: ms(1) });
  });
});

describe("when the run last moved", () => {
  it("moves on every step start, end and append, thinking included, and stays when the run ends", () => {
    const { store, projector } = fixture();
    const started = projector.observe(event(0, { type: "turn.started" }))!;
    expect(started.lastActivityAt).toBeUndefined();
    expect(projector.observe(observed(2, { kind: "activity", activity: { id: "think", actorId: "parent", kind: "reasoning", label: "Thinking", state: "running", startedAt: ms(2) } }))!.lastActivityAt).toBe(ms(2));
    expect(projector.observe(observed(4, { kind: "activity", append: "text", activity: { id: "think", actorId: "parent", kind: "reasoning", label: "Thinking", state: "running", startedAt: ms(4), text: "Hmm" } }))!.lastActivityAt).toBe(ms(4));
    expect(projector.observe(step(7, "bash", { label: "Bash" }))!.lastActivityAt).toBe(ms(7));
    expect(projector.observe(observed(9, { kind: "activity", append: "output", activity: { id: "bash", actorId: "parent", kind: "tool", label: "Bash", state: "running", startedAt: ms(9), output: "ok" } }))!.lastActivityAt).toBe(ms(9));
    expect(projector.observe(step(12, "bash", { label: "Bash", state: "done", endedAt: ms(12) }))!.lastActivityAt).toBe(ms(12));
    expect(projector.observe(observed(15, { kind: "actor", actor: { id: "parent", kind: "parent", label: "Scout", state: "running", startedAt: ms(0) } }))!.lastActivityAt).toBe(ms(12));
    expect(projector.observe(observed(8, { kind: "activity", append: "text", activity: { id: "think", actorId: "parent", kind: "reasoning", label: "Thinking", state: "running", startedAt: ms(8), text: "late" } }))!.lastActivityAt).toBe(ms(12));
    const finished = projector.observe(event(20, { type: "turn.completed", ok: true }))!;
    expect(finished).toMatchObject({ observation: "complete", lastActivityAt: ms(12) });
    expect(store.get(finished.id)!.lastActivityAt).toBe(ms(12));
  });
});

it("shares the home's plain subject with the live current activity", () => {
  const { projector } = fixture();
  projector.observe(event(0, { type: "turn.started" }));
  const run = projector.observe(step(1, "tests", { label: "Bash", subject: "Run the order form tests" }))!;
  expect(run.currentActivity).toMatchObject({ id: "tests", subject: "Run the order form tests", startedAt: ms(1) });
});
