import { expect, it } from "vitest";
import { HelperBoard } from "./helper-board.ts";
import type { Helper } from "../../shared/helpers.ts";

it("scopes live helpers, keeps settled results briefly and clears a new turn", () => {
  let now = 0;
  const board = new HelperBoard(() => now);
  const helper: Helper = { id: "a", kind: "agent", label: "Check", state: "running", background: true, startedAt: 0 };
  board.update("private", helper);
  board.update("visible", helper);
  expect(board.snapshot(id => id === "visible").helpers).toEqual({ visible: [helper] });
  board.settle("visible");
  now = 20_000;
  expect(board.running("visible")).toBe(true);
  board.update("visible", { ...helper, state: "done" });
  board.settle("visible");
  now += 9_999;
  expect(board.snapshot(() => true).helpers.visible).toHaveLength(1);
  now += 1;
  expect(board.snapshot(() => true).helpers.visible).toBeUndefined();
  board.start("private");
  expect(board.snapshot(() => true)).toEqual({ helpers: {} });
});


it("terminalizes timed-out helpers and workflow members without claiming confirmed shutdown", () => {
  let now = 5_000;
  const board = new HelperBoard(() => now);
  const helper: Helper = { id: "workflow", kind: "workflow", label: "Review", state: "running", background: true, startedAt: 1_000,
    members: [{ id: "active", label: "Check", state: "running" }, { id: "done", label: "Read", state: "done" }] };
  board.update("room", helper);
  board.update("room", { ...helper, id: "finished", state: "done", endedAt: 4_000 });
  board.update("other", helper);
  const activity = "The room turn timed out; helper shutdown was requested.";
  const updates = board.fail("room", activity);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ id: "workflow", state: "failed", endedAt: 5_000, activity,
    members: [{ id: "active", state: "failed", activity }, { id: "done", state: "done" }] });
  expect(board.running("room")).toBe(false);
  expect(board.running("other")).toBe(true);
  board.update("room", helper);
  expect(board.running("room")).toBe(false);
  expect(board.fail("room", activity)).toEqual([]);
  now += 10_000;
  expect(board.snapshot(() => true).helpers.room).toBeUndefined();
  expect(board.snapshot(() => true).helpers.other).toEqual([helper]);
});
