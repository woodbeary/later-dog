import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { WorkState } from "../../shared/work-state";
import { roomRowLine, sidebarWorkLine, workAfterEvent, workLine } from "./work-state";

const NOW = new Date(2026, 10, 11, 2, 0).getTime();
const SIX = new Date(2026, 10, 11, 6, 0).getTime();
const event = (body: Record<string, unknown>): RuntimeEvent =>
  ({ eventId: "e", provider: "fake", threadId: "t", createdAt: "2026-11-11T00:00:00Z", ...body }) as RuntimeEvent;

describe("the work line", () => {
  it.each<[WorkState | undefined, string | null]>([
    [undefined, null],
    [{ kind: "idle" }, null],
    [{ kind: "running" }, null],
    [{ kind: "running", dogs: [] }, null],
    [{ kind: "running", dogs: [{ id: "s", name: "Scout" }] }, "Scout is working"],
    [{ kind: "running", computerJobs: 1, computerSince: 5 }, "Running a command on its computer"],
    [{ kind: "running", computerJobs: 2 }, "Running 2 commands on its computer"],
    [{ kind: "running", helpers: 1 }, null],
    [{ kind: "running", dogs: [{ id: "s", name: "Scout" }, { id: "b", name: "Biscuit" }] }, "Scout and Biscuit are working"],
    [{ kind: "waiting-on-dog", dogs: [{ id: "s", name: "Scout" }] }, "Waiting on Scout"],
    [{ kind: "waiting-on-dog", dogs: [{ id: "s", name: "Scout" }, { id: "p", name: "Patch" }] }, "Waiting on Scout and Patch"],
    [{ kind: "waiting-for-usage", until: SIX }, "Waiting for usage until 6:00 AM"],
    [{ kind: "waiting-for-usage", account: "Work", until: SIX }, "Waiting for usage on Work until 6:00 AM"],
    [{ kind: "waiting-for-usage" }, "Waiting for usage to reset"],
    [{ kind: "waiting-for-usage", until: NOW - 1 }, "Waiting for usage to reset"],
    [{ kind: "retrying", attempt: 2 }, "Reconnecting to the engine, try 2"],
    [{ kind: "retrying" }, "Reconnecting to the engine"],
    [{ kind: "waiting-for-computer", holder: "Patch" }, "Waiting for the computer while Patch uses it"],
    [{ kind: "needs-you", what: "Allow sending?" }, "Needs you: Allow sending?"],
    [{ kind: "stopped", cause: "you" }, "Stopped by you"],
    [{ kind: "stopped", cause: "infrastructure", detail: "stalled" }, "Stopped: no progress for too long"],
    [{ kind: "stopped", cause: "engine" }, "Stopped: the engine reported an error"],
  ])("%j reads %j", (work, line) => {
    expect(workLine(work, NOW)).toBe(line);
  });

  it("a reset on another day names the day", () => {
    expect(workLine({ kind: "waiting-for-usage", until: SIX + 24 * 60 * 60_000 }, NOW)).toBe("Waiting for usage until Thu 6:00 AM");
  });

  it("the sidebar leaves questions to the approval wording and keeps your own stop quiet", () => {
    expect(sidebarWorkLine({ kind: "needs-you", what: "x" }, NOW)).toBeNull();
    expect(sidebarWorkLine({ kind: "stopped", cause: "you" }, NOW)).toBeNull();
    expect(sidebarWorkLine({ kind: "running", computerJobs: 1, computerSince: NOW }, NOW)).toBe("Running a command on its computer");
    expect(sidebarWorkLine({ kind: "retrying", attempt: 3 }, NOW)).toBe("Reconnecting to the engine, try 3");
  });
});

describe("runtime frames between home updates", () => {
  it("a retry or a computer wait replaces running, and the wait ends back to running", () => {
    expect(workAfterEvent({ kind: "running" }, event({ type: "turn.retrying", attempt: 1, delayMs: 1, reason: "x" }))).toEqual({ kind: "retrying", attempt: 2 });
    const waiting = workAfterEvent({ kind: "running" }, event({ type: "turn.wait_started", resource: "mac", holder: { name: "Patch" } }));
    expect(waiting).toEqual({ kind: "waiting-for-computer", holder: "Patch" });
    expect(workAfterEvent(waiting, event({ type: "turn.wait_ended", resource: "mac", waitedMs: 1, outcome: "acquired" }))).toEqual({ kind: "running" });
  });

  it("never outranks a question or invents work for a client with no work state", () => {
    const asking: WorkState = { kind: "needs-you" };
    expect(workAfterEvent(asking, event({ type: "turn.retrying", attempt: 1, delayMs: 1, reason: "x" }))).toBe(asking);
    expect(workAfterEvent(undefined, event({ type: "turn.retrying", attempt: 1, delayMs: 1, reason: "x" }))).toBeUndefined();
  });

  it("an engine that exits mid-turn reads as stopped", () => {
    expect(workAfterEvent({ kind: "running" }, event({ type: "session.exited" }))).toEqual({ kind: "stopped", cause: "engine", detail: "closed" });
  });
});

describe("a room's row", () => {
  it("says who is working or who is waited on, and asks for the person first", () => {
    expect(roomRowLine({ kind: "running", dogs: [{ id: "s", name: "Scout" }] }, NOW)).toBe("Scout is working");
    expect(roomRowLine({ kind: "waiting-on-dog", dogs: [{ id: "b", name: "Biscuit" }] }, NOW)).toBe("Waiting on Biscuit");
    expect(roomRowLine({ kind: "needs-you", what: "Allow the deploy?" }, NOW)).toBe("Needs you: Allow the deploy?");
  });

  it("says nothing for an old home that sends no state, or an idle room", () => {
    expect(roomRowLine(undefined, NOW)).toBeNull();
    expect(roomRowLine({ kind: "idle" }, NOW)).toBeNull();
  });
});
