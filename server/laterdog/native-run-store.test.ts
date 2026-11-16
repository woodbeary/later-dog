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
