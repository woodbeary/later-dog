import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LimitHold } from "./limit-hold.ts";

const NOW = Date.parse("2026-10-07T18:30:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const at = (offset: number) => new Date(NOW + offset).toISOString();

const setup = (rests: Record<string, string | undefined>) => {
  const wake = vi.fn();
  return { hold: new LimitHold({ restsUntil: (instanceId) => rests[instanceId], wake }), wake };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("holding queued messages while an account is out of usage", () => {
  it("holds the conversation until the account resets, then wakes the queue once", () => {
    const { hold, wake } = setup({ claude: at(30 * MINUTE) });
    hold.hold("thread-1", "claude");
    hold.hold("thread-1", "claude");
    expect(hold.holds("thread-1")).toBe(true);
    expect(hold.holds("thread-2")).toBe(false);
    vi.advanceTimersByTime(30 * MINUTE - 1);
    expect(wake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(wake).toHaveBeenCalledOnce();
    expect(hold.holds("thread-1")).toBe(false);
    vi.runAllTimers();
    expect(wake).toHaveBeenCalledOnce();
  });

  it("lets go when the conversation runs again or the account comes back early", () => {
    const rests: Record<string, string | undefined> = { claude: at(30 * MINUTE) };
    const { hold, wake } = setup(rests);
    hold.hold("thread-1", "claude");
    hold.release("thread-1");
    hold.release("thread-1");
    expect(hold.holds("thread-1")).toBe(false);
    hold.hold("thread-2", "claude");
    rests.claude = undefined;
    expect(hold.holds("thread-2")).toBe(false);
    vi.runAllTimers();
    expect(wake).not.toHaveBeenCalled();
  });

  it("holds nothing for an account that is not out of usage", () => {
    const { hold, wake } = setup({ claude: at(-MINUTE), garbled: "soon" });
    for (const instanceId of ["claude", "garbled", "unknown"]) hold.hold(instanceId, instanceId);
    expect(["claude", "garbled", "unknown"].some((threadId) => hold.holds(threadId))).toBe(false);
    vi.runAllTimers();
    expect(wake).not.toHaveBeenCalled();
  });

  it("keeps waiting past the longest timer, and through a reset that moved later", () => {
    const rests: Record<string, string | undefined> = { claude: at(30 * DAY) };
    const { hold, wake } = setup(rests);
    hold.hold("thread-1", "claude");
    vi.advanceTimersByTime(25 * DAY);
    expect(wake).not.toHaveBeenCalled();
    expect(hold.holds("thread-1")).toBe(true);
    rests.claude = at(31 * DAY);
    vi.advanceTimersByTime(5 * DAY);
    expect(wake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DAY);
    expect(wake).toHaveBeenCalledOnce();
    expect(hold.holds("thread-1")).toBe(false);
  });
});
