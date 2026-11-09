import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeObservation } from "../../shared/native-runs.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { NativeRunProjector } from "./native-run-projector.ts";
import { ensureNativeRuns, NativeRunStore } from "./native-run-store.ts";

const directories: string[] = [];
const open: DatabaseSync[] = [];
afterEach(() => {
  for (const database of open.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const connect = (path: string) => {
  const database = new DatabaseSync(path);
  open.push(database);
  ensureNativeRuns(database);
  return new NativeRunStore({
    read: fn => fn(database),
    write: fn => {
      database.exec("BEGIN IMMEDIATE");
      try { const value = fn(database); database.exec("COMMIT"); return value; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  });
};

let counter = 0;
const base = (threadId: string, turnId: string) => ({ eventId: `p-${++counter}`, threadId, turnId, provider: "claudeAgent", providerInstanceId: "claude-a", createdAt: new Date(1_000 + counter).toISOString() });
const observed = (threadId: string, turnId: string, observation: NativeObservation): RuntimeEvent => ({ ...base(threadId, turnId), type: "native.observed", observation });

describe("native run persistence across process restart and backup", () => {
  it("keeps a completed child's receipt after the parent completes and the process restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "laterdog-native-persist-"));
    directories.push(directory);
    const path = join(directory, "messages.db");
    const first = new NativeRunProjector(connect(path), () => {});
    first.observe({ ...base("chat", "turn-1"), type: "turn.started" });
    first.observe(observed("chat", "turn-1", { kind: "actor", actor: { id: "child", parentId: "parent", kind: "subagent", label: "Scout", state: "running", startedAt: 1000, task: "Check sources" } }));
    first.observe(observed("chat", "turn-1", { kind: "activity", activity: { id: "search", actorId: "child", kind: "search", label: "Search", state: "done", startedAt: 1001, text: "Found it", links: [{ title: "Doc", url: "https://example.com/doc" }] } }));
    first.observe(observed("chat", "turn-1", { kind: "actor", actor: { id: "child", parentId: "parent", kind: "subagent", label: "Scout", state: "done", startedAt: 1000, endedAt: 1100, summary: "Verified" } }));
    const run = first.observe({ ...base("chat", "turn-1"), type: "turn.completed", ok: true, stopReason: "end_turn", cost: null })!;
    expect(run).toMatchObject({ state: "done", observation: "complete" });
    open.splice(0).forEach(database => database.close());

    const second = connect(path);
    second.recoverInterrupted();
    const detail = second.detail("chat", run.id)!;
    expect(detail.run.actors.find(actor => actor.id === "child")).toMatchObject({ state: "done", summary: "Verified", parentId: "parent" });
    expect(detail.activities).toEqual([expect.objectContaining({ id: "search", links: [{ title: "Doc", url: "https://example.com/doc" }] })]);
    expect(detail.run.observation).toBe("complete");
  });

  it("marks work that was live at shutdown interrupted without discarding what was observed", () => {
    const directory = mkdtempSync(join(tmpdir(), "laterdog-native-persist-"));
    directories.push(directory);
    const path = join(directory, "messages.db");
    const first = new NativeRunProjector(connect(path), () => {});
    const run = first.observe(observed("chat", "turn-live", { kind: "actor", actor: { id: "child", parentId: "parent", kind: "subagent", label: "Scout", state: "running", startedAt: 1000, canStop: true } }))!;
    open.splice(0).forEach(database => database.close());
    const second = connect(path);
    second.recoverInterrupted();
    const recovered = second.get(run.id)!;
    expect(recovered.observation).toBe("interrupted");
    expect(recovered.actors.every(actor => actor.canStop === false)).toBe(true);
    expect(recovered.actors.find(actor => actor.id === "child")).toMatchObject({ label: "Scout" });
  });

  it("restores from a database backup with its receipts and keeps threads separate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "laterdog-native-persist-"));
    directories.push(directory);
    const sourcePath = join(directory, "messages.db");
    const projector = new NativeRunProjector(connect(sourcePath), () => {});
    for (const threadId of ["chat-a", "chat-b"]) {
      projector.observe(observed(threadId, "turn", { kind: "actor", actor: { id: `child-${threadId}`, parentId: "parent", kind: "subagent", label: threadId, state: "done", startedAt: 1, endedAt: 2 } }));
      projector.observe({ ...base(threadId, "turn"), type: "turn.completed", ok: true, stopReason: "end_turn", cost: null });
    }
    const source = open[0]!;
    const restoredPath = join(directory, "restored.db");
    await backup(source, restoredPath);
    const restored = connect(restoredPath);
    const listA = restored.list("chat-a");
    expect(listA.runs).toHaveLength(1);
    expect(listA.runs[0]!.actors.map(actor => actor.id)).toContain("child-chat-a");
    expect(listA.runs[0]!.actors.map(actor => actor.id)).not.toContain("child-chat-b");
    expect(restored.list("chat-b").runs).toHaveLength(1);
  });
});
