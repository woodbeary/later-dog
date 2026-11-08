import { describe, expect, it } from "vitest";
import { ExecutionEvidenceTracker } from "./execution-evidence.ts";
import type { RuntimeEvent } from "../contracts.ts";

const selected = { instanceId: "claude", model: "selected", effort: "medium" as const };
const dispatched = { instanceId: "codex", model: "actual", effort: "low" as const };
const event = (value: Record<string, unknown>) => ({ threadId: "thread", provider: "codex", createdAt: "2026-11-08T00:00:00Z", ...value }) as RuntimeEvent;

describe("execution evidence", () => {
  it("freezes selection at dispatch and records the provider model without calling success verified", () => {
    let now = 1000;
    const tracker = new ExecutionEvidenceTracker(() => now);
    tracker.dispatch("thread", selected, dispatched, "Fix account controls");
    tracker.observe(event({ type: "turn.started", turnId: "turn", providerInstanceId: "codex" }));
    tracker.observe(event({ type: "session.started", turnId: "turn", model: "provider-model", providerInstanceId: "codex" }));
    now = 5000;
    const done = tracker.complete(event({ type: "turn.completed", turnId: "turn", ok: true }) as Extract<RuntimeEvent, { type: "turn.completed" }>);
    expect(done).toMatchObject({ selected, dispatched, reportedModel: "provider-model", attribution: "provider", durationMs: 4000, providerSucceeded: true, verification: "unverified" });
    expect(tracker.complete(event({ type: "turn.completed", turnId: "turn", ok: true }) as Extract<RuntimeEvent, { type: "turn.completed" }>)).toBeUndefined();
  });

  it("keeps a newer turn when an old completion or session event arrives", () => {
    const tracker = new ExecutionEvidenceTracker();
    tracker.dispatch("thread", selected, dispatched, "new task");
    tracker.observe(event({ type: "turn.started", turnId: "new" }));
    tracker.observe(event({ type: "session.started", turnId: "old", model: "wrong" }));
    expect(tracker.complete(event({ type: "turn.completed", turnId: "old", ok: true }) as Extract<RuntimeEvent, { type: "turn.completed" }>)).toBeUndefined();
    const done = tracker.complete(event({ type: "turn.completed", turnId: "new", ok: false }) as Extract<RuntimeEvent, { type: "turn.completed" }>);
    expect(done).toMatchObject({ attribution: "dispatch", providerSucceeded: false });
    expect(done?.reportedModel).toBeUndefined();
  });

  it("flags a different executing provider and clears cancelled dispatches", () => {
    const tracker = new ExecutionEvidenceTracker();
    tracker.dispatch("thread", selected, dispatched, "task");
    tracker.observe(event({ type: "turn.started", turnId: "turn", providerInstanceId: "claude" }));
    tracker.observe(event({ type: "session.started", turnId: "turn", model: "other" }));
    expect(tracker.complete(event({ type: "turn.completed", turnId: "turn", ok: false }) as Extract<RuntimeEvent, { type: "turn.completed" }>)).toMatchObject({ attribution: "conflict" });
    tracker.dispatch("thread", selected, dispatched, "cancelled");
    tracker.cancel("thread");
    expect(tracker.complete(event({ type: "turn.completed", ok: false }) as Extract<RuntimeEvent, { type: "turn.completed" }>)).toBeUndefined();
  });
});
