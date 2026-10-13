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
