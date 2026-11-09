import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NativeActor } from "../shared/native-runs.ts";
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { NativeRunProjector } from "../server/laterdog/native-run-projector.ts";
import { ensureNativeRuns, NativeRunStore } from "../server/laterdog/native-run-store.ts";

const folder = mkdtempSync(join(tmpdir(), "laterdog-native-smoke-"));
const path = join(folder, "work.sqlite");
let database = new DatabaseSync(path);
let sequence = 0;
const access = { read: <T>(read: (db: DatabaseSync) => T): T => read(database), write: <T>(write: (db: DatabaseSync) => T): T => write(database) };
const event = (data: Record<string, unknown>) => ({ eventId: `e-${++sequence}`, threadId: "fixture-thread", provider: "codex", providerInstanceId: "fixture-account", turnId: "first-turn", createdAt: new Date(1_000 + sequence).toISOString(), ...data }) as RuntimeEvent;
const child: NativeActor = { id: "child:1", kind: "subagent", parentId: "parent", label: "Inspector", state: "running", generation: "1", startedAt: 1_000, canStop: true };
try {
  ensureNativeRuns(database);
  const store = new NativeRunStore(access);
  const projector = new NativeRunProjector(store, () => undefined);
  projector.observe(event({ type: "turn.started" }));
  const observed = event({ type: "native.observed", observation: { kind: "actor", actor: child } });
  const run = projector.observe(observed)!;
  const revision = run.revision;
  projector.observe(observed);
  assert.equal(store.get(run.id)!.revision, revision);
  projector.observe(event({ type: "native.observed", observation: { kind: "activity", activity: { id: "read", actorId: child.id, kind: "tool", label: "Read fixture", state: "done", startedAt: 1_001, output: "fixture-result" } } }));
  projector.observe(event({ type: "turn.completed", ok: true }));
  assert.equal(store.get(run.id)!.observation, "partial");
  projector.observe(event({ type: "native.observed", observation: { kind: "actor", actor: { ...child, state: "done", endedAt: 1_005 } } }));
  assert.equal(store.get(run.id)!.observation, "complete");
  const pending = projector.observe(event({ type: "native.observed", turnId: "second-turn", observation: { kind: "actor", actor: { ...child, id: "child:2", generation: "2" } } }))!;
  database.close();
  database = new DatabaseSync(path);
  ensureNativeRuns(database);
  const reopened = new NativeRunStore(access);
  reopened.recoverInterrupted();
  const retained = reopened.detail("fixture-thread", run.id)!;
  assert.equal(retained.run.observation, "complete");
  assert.equal(retained.activities.find(row => row.id === "read")?.output, "fixture-result");
  assert.equal(reopened.get(pending.id)!.observation, "interrupted");
  assert.ok(reopened.get(pending.id)!.actors.every(actor => actor.canStop === false));
  assert.equal(reopened.detail("another-thread", run.id), undefined);
  process.stdout.write(JSON.stringify({ ok: true, scope: "isolated durable native projection", checks: ["duplicate event", "child isolation", "late completion", "disk reopen", "interrupted recovery", "retained result", "thread boundary"], providerQualified: false }) + "\n");
} finally {
  database.close();
  rmSync(folder, { recursive: true, force: true });
}
