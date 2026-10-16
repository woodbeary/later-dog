import { describe, expect, it } from "vitest";

import { DEFAULT_TOOL_MAX_MS, TurnWatchdog, toolRunningSince, type WatchedTurn } from "./turn-watchdog.ts";

const STALL = 10_000;

function rig() {
  let now = 0;
  const stalls: WatchedTurn[] = [];
  const dog = new TurnWatchdog({
    stallMs: STALL,
    checkMs: 60_000,
    onStall: (turn) => stalls.push(turn),
    now: () => now,
  });
  return { dog, stalls, tick: (ms: number) => (now += ms) };
}

describe("TurnWatchdog", () => {
  it("stalls a silent turn once, and only once", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ threadId: "t1", botId: "bot1" })]);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    expect(dog.watching("t1")).toBe(false);
  });

  it("any event on the thread resets the clock", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    for (let i = 0; i < 10; i++) {
      tick(STALL - 1);
      dog.touch("t1");
    }
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("never stalls a turn waiting on a human, however long they take", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnHuman("t1", true);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    dog.setWaitingOnHuman("t1", false);
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("lets the helper deadline govern then restarts the silence clock", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnHelpers("t1", true);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    dog.setWaitingOnHelpers("t1", false);
    tick(STALL + 1);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("caps helpers even when progress keeps arriving", () => {
    let now = 0;
    const stalls: WatchedTurn[] = [];
    const dog = new TurnWatchdog({ stallMs: STALL, checkMs: 1_000, helpersMaxMs: 30_000, now: () => now, onStall: turn => stalls.push(turn) });
    dog.watch("t", "b"); dog.setWaitingOnHelpers("t", true);
    now = 29_999; dog.touch("t"); dog.sweep(); expect(stalls).toHaveLength(0);
    now = 30_000; dog.setWaitingOnHelpers("t", true); dog.sweep(); expect(stalls).toHaveLength(1);
  });

  it("a settled turn is forgotten", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.settle("t1");
    tick(STALL * 2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
  });

  it("lets the computer wait's own deadline govern, then restarts the stall clock", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.setWaitingOnComputer("t1", true);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    dog.setWaitingOnHuman("t1", false);
    tick(STALL * 100);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    dog.setWaitingOnComputer("t1", false);
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("re-watching a thread replaces the previous turn", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    tick(STALL - 1);
    dog.watch("t1", "bot2");
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(STALL);
    dog.sweep();
    expect(stalls).toEqual([expect.objectContaining({ botId: "bot2" })]);
  });

  it("counts a tool call that is still running as alive, however quiet it is", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observeTool({ type: "item.started", threadId: "t1", itemType: "tool", itemId: "bash-1" });
    tick(STALL * 30);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    expect(toolRunningSince(dog.snapshot("t1")!)).toBe(0);
    dog.observeTool({ type: "item.completed", threadId: "t1", itemType: "tool", itemId: "bash-1" });
    expect(toolRunningSince(dog.snapshot("t1")!)).toBeUndefined();
    tick(STALL - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(2);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("keeps a turn alive while any of its parallel tools still runs, and ignores reasoning items", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.observeTool({ type: "item.started", threadId: "t1", itemType: "reasoning", itemId: "think" });
    dog.observeTool({ type: "item.started", threadId: "t1", itemType: "tool", itemId: "a" });
    dog.observeTool({ type: "item.started", threadId: "t1", itemType: "tool", itemId: "b" });
    dog.observeTool({ type: "item.completed", threadId: "t1", itemType: "tool", itemId: "a" });
    tick(STALL * 5);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    dog.observeTool({ type: "item.completed", threadId: "t1", itemType: "tool", itemId: "b" });
    tick(STALL + 1);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });

  it("still stops a tool that runs past its own time limit, and says so", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.toolStarted("t1", "stuck");
    tick(DEFAULT_TOOL_MAX_MS - 1);
    dog.sweep();
    expect(stalls).toHaveLength(0);
    tick(1);
    dog.sweep();
    expect(stalls).toHaveLength(1);
    expect(dog.toolOverran(stalls[0]!)).toBe(true);
  });

  it("forgets running tools when the turn settles", () => {
    const { dog, stalls, tick } = rig();
    dog.watch("t1", "bot1");
    dog.toolStarted("t1", "bash-1");
    dog.settle("t1");
    dog.watch("t1", "bot1");
    tick(STALL + 1);
    dog.sweep();
    expect(stalls).toHaveLength(1);
  });
});
