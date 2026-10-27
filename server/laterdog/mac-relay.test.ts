import { describe, expect, it, vi } from "vitest";
import { MAC_RELAY_OFFLINE_RESULT, MacRelayQueue } from "./mac-relay.ts";

describe("MacRelayQueue", () => {
  it("delivers a job to the Mac and resolves the turn with its reply", async () => {
    const queue = new MacRelayQueue();
    const turn = queue.requestTurn("bot-1", "thread-1", "fix the bug");
    const job = queue.nextJob("bot-1");
    expect(job?.text).toBe("fix the bug");
    expect(queue.nextJob("bot-1")).toBeNull();
    queue.completeJob(job!.id, "fixed it");
    await expect(turn).resolves.toBe("fixed it");
  });

  it("keeps jobs for different bots separate and in order", () => {
    const queue = new MacRelayQueue();
    void queue.requestTurn("bot-1", "thread-1", "first");
    void queue.requestTurn("bot-1", "thread-1", "second");
    void queue.requestTurn("bot-2", "thread-2", "other bot");
    expect(queue.nextJob("bot-1")?.text).toBe("first");
    expect(queue.nextJob("bot-2")?.text).toBe("other bot");
    expect(queue.nextJob("bot-1")?.text).toBe("second");
    expect(queue.nextJob("bot-1")).toBeNull();
  });

  it("rejects the turn when the Mac reports a failure", async () => {
    const queue = new MacRelayQueue();
    const turn = queue.requestTurn("bot-1", "thread-1", "fix the bug");
    const job = queue.nextJob("bot-1")!;
    queue.failJob(job.id, "the local engine crashed");
    await expect(turn).rejects.toThrow("the local engine crashed");
  });

  it("times out a job no Mac ever claims, with a plain-language message", async () => {
    vi.useFakeTimers();
    try {
      const queue = new MacRelayQueue();
      const turn = queue.requestTurn("bot-1", "thread-1", "fix the bug");
      turn.catch(() => {});
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await expect(turn).rejects.toThrow(MAC_RELAY_OFFLINE_RESULT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a job a Mac claimed but never answered", async () => {
    vi.useFakeTimers();
    try {
      const queue = new MacRelayQueue();
      const turn = queue.requestTurn("bot-1", "thread-1", "fix the bug");
      turn.catch(() => {});
      queue.nextJob("bot-1");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await expect(turn).rejects.toThrow(MAC_RELAY_OFFLINE_RESULT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a completion or failure for an unknown or already-settled job", () => {
    const queue = new MacRelayQueue();
    expect(queue.completeJob("no-such-job", "text")).toBe(false);
    expect(queue.failJob("no-such-job", "nope")).toBe(false);
  });

  it("reports how many turns are waiting for a bot's Mac", () => {
    const queue = new MacRelayQueue();
    expect(queue.pendingCount("bot-1")).toBe(0);
    void queue.requestTurn("bot-1", "thread-1", "one");
    void queue.requestTurn("bot-1", "thread-1", "two");
    expect(queue.pendingCount("bot-1")).toBe(2);
    queue.nextJob("bot-1");
    expect(queue.pendingCount("bot-1")).toBe(1);
  });
});
