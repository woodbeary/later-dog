import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeActivity } from "../../shared/native-runs.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { liveStep } from "../../shared/step-words.ts";
import { liveStepsFrom } from "./live-step.ts";
import { NativeRunProjector } from "./native-run-projector.ts";
import { ensureNativeRuns, NativeRunStore } from "./native-run-store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  ensureNativeRuns(database);
  const access = { read: <T>(fn: (database: DatabaseSync) => T): T => fn(database), write: <T>(fn: (database: DatabaseSync) => T): T => fn(database) };
  const store = new NativeRunStore(access);
  const projector = new NativeRunProjector(store, () => undefined);
  let clock = 0;
  let sequence = 0;
  const steps = liveStepsFrom(access, () => clock);
  const send = (at: number, data: Record<string, unknown>, threadId = "chat") => {
    clock = at;
    projector.observe({ eventId: `e-${++sequence}`, threadId, provider: "claude", providerInstanceId: "account-a", turnId: `${threadId}-turn`, createdAt: new Date(at).toISOString(), ...data } as RuntimeEvent);
  };
  const step = (at: number, id: string, extra: Partial<NativeActivity> = {}, threadId = "chat") =>
    send(at, { type: "native.observed", observation: { kind: "activity", activity: { id, actorId: "parent", kind: "tool", label: "Bash", state: "running", startedAt: at, ...extra } } }, threadId);
  const append = (at: number, id: string, output: string) =>
    send(at, { type: "native.observed", observation: { kind: "activity", append: "output", activity: { id, actorId: "parent", kind: "tool", label: "Bash", state: "running", startedAt: at, output } } });
  const run = (threadId = "chat") => store.live(threadId)[0];
  return { steps, send, step, append, run, at: (ms: number) => { clock = ms; } };
}

describe("the live step sent with a dog and a task", () => {
  it("is exactly liveStep of the chat's live run, and nothing when no run is live", () => {
    const f = fixture();
    expect(f.steps.step("chat")).toBeNull();
    f.send(1_000, { type: "turn.started" });
    const started = f.run()!;
    expect(f.steps.step("chat")).toEqual(liveStep(started));
    expect(f.steps.step("chat")).toEqual({ id: `${started.id}:thinking:0`, kind: "thinking", startedAt: 1_000, lastActivityAt: 1_000 });
    f.step(2_000, "bash");
    expect(f.steps.step("chat")).toEqual(liveStep(f.run()));
    expect(f.steps.step("chat")).toEqual({ id: "bash", kind: "running", startedAt: 2_000, lastActivityAt: 2_000 });
    expect(f.steps.step("elsewhere")).toBeNull();
    f.send(3_000, { type: "turn.completed", ok: true });
    expect(f.run()).toBeUndefined();
    expect(f.steps.step("chat")).toBeNull();
  });

  it.each([
    ["reasoning", "Thinking", "thinking"],
    ["tool", "Read", "reading"],
    ["tool", "Edit", "editing"],
    ["tool", "mcp__computer__screenshot", "screen"],
    ["search", "WebSearch: pickup times", "searching"],
    ["message", "Message", "working"],
  ] as Array<[NativeActivity["kind"], string, string]>)("reads a %s step labelled %s as %s", (kind, label, expected) => {
    const f = fixture();
    f.step(1_000, "current", { kind, label });
    expect(f.steps.step("chat")).toMatchObject({ id: "current", kind: expected, startedAt: 1_000 });
  });

  it("keeps one id while the dog thinks between steps, until a new step arrives", () => {
    const f = fixture();
    f.step(1_000, "bash");
    f.step(2_000, "bash", { state: "done", endedAt: 2_000 });
    const runId = f.run()!.id;
    expect(f.steps.step("chat")).toEqual({ id: `${runId}:thinking:1`, kind: "thinking", startedAt: 2_000, lastActivityAt: 2_000 });
    f.at(9_000);
    expect(f.steps.step("chat")?.id).toBe(`${runId}:thinking:1`);
    f.at(30_000);
    expect(f.steps.step("chat")?.id).toBe(`${runId}:thinking:1`);
    f.step(31_000, "read", { label: "Read" });
    expect(f.steps.step("chat")).toEqual({ id: "read", kind: "reading", startedAt: 31_000, lastActivityAt: 31_000 });
  });

  it("sends a new step at once but its last-moved time at most once every 5 seconds per dog", () => {
    const f = fixture();
    f.step(10_000, "bash");
    expect(f.steps.due("chat")).toBe(true);
    expect(f.steps.step("chat")).toMatchObject({ id: "bash", lastActivityAt: 10_000 });
    expect(f.steps.due("chat")).toBe(false);
    f.append(11_000, "bash", "one");
    expect(f.steps.due("chat")).toBe(false);
    expect(f.steps.step("chat")).toMatchObject({ id: "bash", lastActivityAt: 10_000 });
    f.append(14_999, "bash", "two");
    expect(f.steps.due("chat")).toBe(false);
    expect(f.steps.step("chat")).toMatchObject({ id: "bash", lastActivityAt: 10_000 });
    f.at(15_000);
    expect(f.steps.due("chat")).toBe(true);
    expect(f.steps.step("chat")).toMatchObject({ id: "bash", lastActivityAt: 14_999 });
    f.append(16_000, "bash", "three");
    expect(f.steps.step("chat")).toMatchObject({ id: "bash", lastActivityAt: 14_999 });
    f.step(16_500, "read", { label: "Read" });
    expect(f.steps.due("chat")).toBe(true);
    expect(f.steps.step("chat")).toMatchObject({ id: "read", kind: "reading", lastActivityAt: 16_500 });
    f.step(16_600, "other-bash", {}, "other");
    expect(f.steps.due("other")).toBe(true);
    expect(f.steps.step("other")).toMatchObject({ id: "other-bash", lastActivityAt: 16_600 });
    f.at(17_000);
    expect(f.steps.due("chat")).toBe(false);
  });

  it("says a push is due when the run ends, and not again after that", () => {
    const f = fixture();
    f.step(1_000, "bash");
    f.steps.step("chat");
    f.send(1_500, { type: "turn.completed", ok: true });
    expect(f.steps.due("chat")).toBe(true);
    expect(f.steps.step("chat")).toBeNull();
    expect(f.steps.due("chat")).toBe(false);
  });
});
