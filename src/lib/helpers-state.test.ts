import { afterEach, describe, expect, it } from "vitest";
import { HELPER_LIMIT, type Helper } from "../../shared/helpers";
import type { RuntimeEvent } from "../../shared/runtime-events";
import {
  HELPER_SETTLED_SHOW_MS,
  currentHelpers,
  forgetHelpers,
  helperFrom,
  helpersFromSnapshot,
  helpersInView,
  nextHelperChange,
  receiveHelperEvent,
  receiveHelpersSnapshot,
  withHelperUpdate,
} from "./helpers-state";

function helper(id: string, patch: Partial<Helper> = {}): Helper {
  return { id, kind: "agent", label: `Helper ${id}`, state: "running", background: true, startedAt: 1_000, ...patch };
}

function updated(threadId: string, next: Helper): RuntimeEvent {
  return { type: "helper.updated", provider: "claude", threadId, eventId: `e-${next.id}-${next.state}`, createdAt: "2026-10-13T12:00:00.000Z", helper: next };
}

afterEach(() => forgetHelpers());

describe("helpers from the server's snapshot", () => {
  it("keeps each thread's helpers and drops what it can't read", () => {
    const threads = helpersFromSnapshot({
      helpers: {
        "thread-a": [helper("one"), { id: "broken" }, { ...helper("two", { kind: "workflow" }), members: [
          { id: "m1", label: "Check the sources", state: "done", phase: "Gather" },
          { label: "No id", state: "running" },
        ] }],
        "thread-b": "not a list",
        "thread-c": [],
      },
    });
    expect(Object.keys(threads)).toEqual(["thread-a"]);
    expect(threads["thread-a"]!.map((entry) => entry.id)).toEqual(["one", "two"]);
    expect(threads["thread-a"]![1]!.members).toEqual([
      expect.objectContaining({ id: "m1", label: "Check the sources", state: "done", phase: "Gather" }),
    ]);
  });

  it("reads nothing from a body without helpers", () => {
    expect(helpersFromSnapshot(null)).toEqual({});
    expect(helpersFromSnapshot({ helpers: [] })).toEqual({});
    expect(helpersFromSnapshot("<html>")).toEqual({});
  });

  it("refuses a helper with an unknown state or no start time", () => {
    expect(helperFrom({ ...helper("x"), state: "paused" })).toBeNull();
    expect(helperFrom({ ...helper("x"), startedAt: "soon" })).toBeNull();
    expect(helperFrom({ ...helper("x"), kind: "mystery" })?.kind).toBe("agent");
  });
});

describe("helper updates from runtime frames", () => {
  it("clears previous helpers when the thread starts a new turn", () => {
    receiveHelpersSnapshot({ helpers: { "thread-a": [helper("one")], "thread-b": [helper("two")] } });
    expect(receiveHelperEvent({ type: "turn.started", provider: "claude", threadId: "thread-a", eventId: "start", turnId: "next", createdAt: "2026-10-13T12:00:00.000Z" })).toBe(true);
    expect(currentHelpers()["thread-a"]).toBeUndefined();
    expect(currentHelpers()["thread-b"]).toEqual([helper("two")]);
  });

  it("adds, updates and settles helpers on top of the snapshot", () => {
    receiveHelpersSnapshot({ helpers: { "thread-a": [helper("one")] } });
    expect(receiveHelperEvent(updated("thread-a", helper("two")))).toBe(true);
    receiveHelperEvent(updated("thread-a", helper("one", { activity: "Reading the notes" })));
    receiveHelperEvent(updated("thread-a", helper("two", { state: "done", endedAt: 9_000 })));
    expect(currentHelpers()["thread-a"]).toEqual([
      expect.objectContaining({ id: "one", state: "running", activity: "Reading the notes" }),
      expect.objectContaining({ id: "two", state: "done", endedAt: 9_000 }),
    ]);
  });

  it("ignores a late running update for a helper that already settled", () => {
    receiveHelperEvent(updated("thread-a", helper("one", { state: "done", endedAt: 5_000 })));
    const before = currentHelpers();
    receiveHelperEvent(updated("thread-a", helper("one", { activity: "Still going" })));
    expect(currentHelpers()).toBe(before);
    expect(currentHelpers()["thread-a"]![0]).toMatchObject({ state: "done" });
  });

  it("leaves other runtime events to the rest of the store", () => {
    const delta: RuntimeEvent = { type: "content.delta", provider: "claude", threadId: "thread-a", eventId: "d", createdAt: "2026-10-13T12:00:00.000Z", streamKind: "reasoning_text", delta: "hm" };
    expect(receiveHelperEvent(delta)).toBe(false);
    expect(currentHelpers()).toEqual({});
  });

  it("keeps at most the helper limit, dropping the oldest settled ones first", () => {
    let threads = {};
    threads = withHelperUpdate(threads, "thread-a", helper("still-running"));
    for (let index = 0; index < HELPER_LIMIT + 3; index += 1) {
      threads = withHelperUpdate(threads, "thread-a", helper(`done-${index}`, { state: "done", endedAt: 2_000 + index }));
    }
    const kept = (threads as Record<string, Helper[]>)["thread-a"]!;
    expect(kept).toHaveLength(HELPER_LIMIT);
    expect(kept[0]!.id).toBe("still-running");
    expect(kept.map((entry) => entry.id)).not.toContain("done-0");
    expect(kept.at(-1)!.id).toBe(`done-${HELPER_LIMIT + 2}`);
  });

  it("replaces everything with a fresh snapshot after a reconnect", () => {
    receiveHelperEvent(updated("thread-a", helper("one")));
    receiveHelpersSnapshot({ helpers: { "thread-b": [helper("two")] } });
    expect(Object.keys(currentHelpers())).toEqual(["thread-b"]);
    receiveHelpersSnapshot(null);
    expect(Object.keys(currentHelpers())).toEqual(["thread-b"]);
  });
});

describe("which helpers show as puppies", () => {
  const turn = 10_000;
  const list = [
    helper("working", { startedAt: 11_000 }),
    helper("finished", { state: "done", startedAt: 11_000, endedAt: 20_000 }),
    helper("broke", { state: "failed", startedAt: 11_000, endedAt: 12_000 }),
    helper("halted", { state: "stopped", startedAt: 11_000, endedAt: 19_000 }),
    helper("old-failure", { state: "failed", startedAt: 1_000, endedAt: 2_000 }),
  ];

  it("shows running helpers, fresh settled ones and this turn's failures", () => {
    expect(helpersInView(list, 21_000, turn).map((entry) => entry.id)).toEqual(["working", "finished", "broke", "halted"]);
  });

  it("lets finished and stopped helpers go after a few seconds", () => {
    expect(helpersInView(list, 20_000 + HELPER_SETTLED_SHOW_MS, turn).map((entry) => entry.id)).toEqual(["working", "broke"]);
    expect(nextHelperChange(list, 21_000)).toBe(19_000 + HELPER_SETTLED_SHOW_MS);
    expect(nextHelperChange([helper("working")], 21_000)).toBeNull();
  });
});
