import { describe, expect, it, vi } from "vitest";
import { guardTurnEnd } from "./turn-end-guard.ts";

describe("a turn that ends while saving fails", () => {
  it("lets the failure through for the log and asks for recovery only for a finished turn", () => {
    const failure = new Error("database or disk is full");
    const recover = vi.fn();
    const guarded = guardTurnEnd((event: { type: string }) => { if (event.type !== "ping") throw failure; }, recover);
    expect(() => guarded({ type: "turn.completed" })).toThrow(failure);
    expect(recover).toHaveBeenCalledWith({ type: "turn.completed" }, failure);
    expect(() => guarded({ type: "message" })).toThrow(failure);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(() => guarded({ type: "ping" })).not.toThrow();
  });

  it("does not let a failing recovery hide the original failure", () => {
    const failure = new Error("first");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const guarded = guardTurnEnd((_event: { type: string }) => { throw failure; }, () => { throw new Error("second"); });
    expect(() => guarded({ type: "turn.completed" })).toThrow(failure);
    spy.mockRestore();
  });
});
