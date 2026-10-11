import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LimitHold, RECHECK_MS } from "./limit-hold.ts";

const NOW = Date.parse("2026-10-07T18:30:00Z");
const MINUTE = 60_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

const setup = (ready: Record<string, string | undefined>) => {
  const wake = vi.fn();
  const onChange = vi.fn();
  return { hold: new LimitHold({ readyAt: (threadId) => ready[threadId], wake, onChange }), wake, onChange };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("waiting for a conversation's usage limit to reset", () => {
  it("holds the conversation until it can run, then wakes it once", () => {
    const { hold, wake, onChange } = setup({ "thread-1": at(30 * MINUTE) });
    hold.hold("thread-1");
    hold.hold("thread-1");
    expect(onChange).toHaveBeenCalledOnce();
    expect(hold.holds("thread-1")).toBe(true);
    expect(hold.holds("thread-2")).toBe(false);
    expect(hold.waiting()).toEqual({ "thread-1": at(30 * MINUTE) });
    vi.advanceTimersByTime(30 * MINUTE - 1);
    expect(wake).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(wake).toHaveBeenCalledExactlyOnceWith("thread-1");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(hold.holds("thread-1")).toBe(false);
    expect(hold.waiting()).toEqual({});
    vi.runAllTimers();
    expect(wake).toHaveBeenCalledOnce();
  });

  it("checks again every minute, so a reset that moves or an account that frees up counts", () => {
    const ready: Record<string, string | undefined> = { "thread-1": at(5 * 60 * MINUTE), "thread-2": at(5 * 60 * MINUTE) };
    const { hold, wake, onChange } = setup(ready);
    hold.hold("thread-1");
    hold.hold("thread-2");
    onChange.mockClear();
    ready["thread-1"] = at(10 * MINUTE);
    ready["thread-2"] = undefined;
    vi.advanceTimersByTime(RECHECK_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith("thread-2");
    expect(hold.waiting()).toEqual({ "thread-1": at(10 * MINUTE) });
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(9 * MINUTE);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenLastCalledWith("thread-1");
  });

  it("checks every held conversation at once when the accounts it may use change", () => {
    const ready: Record<string, string | undefined> = { "thread-1": at(30 * MINUTE), "thread-2": at(30 * MINUTE) };
    const { hold, wake, onChange } = setup(ready);
    hold.hold("thread-1");
    hold.hold("thread-2");
    onChange.mockClear();
    ready["thread-1"] = undefined;
    ready["thread-2"] = at(2 * 60 * MINUTE);
    hold.recheck();
    expect(wake).toHaveBeenCalledExactlyOnceWith("thread-1");
    expect(hold.waiting()).toEqual({ "thread-2": at(2 * 60 * MINUTE) });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(RECHECK_MS);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("lets go without waking when the conversation runs again", () => {
    const { hold, wake, onChange } = setup({ "thread-1": at(30 * MINUTE) });
    hold.hold("thread-1");
    hold.release("thread-1");
    hold.release("thread-1");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(hold.holds("thread-1")).toBe(false);
    vi.runAllTimers();
    expect(wake).not.toHaveBeenCalled();
  });

  it("stops holding queued words once the conversation can run, and still wakes it", () => {
    const ready: Record<string, string | undefined> = { "thread-1": at(30 * MINUTE) };
    const { hold, wake } = setup(ready);
    hold.hold("thread-1");
    ready["thread-1"] = undefined;
    expect(hold.holds("thread-1")).toBe(false);
    vi.advanceTimersByTime(RECHECK_MS);
    expect(wake).toHaveBeenCalledExactlyOnceWith("thread-1");
  });

  it("holds nothing when the conversation can run now", () => {
    const { hold, wake, onChange } = setup({ past: at(-MINUTE), garbled: "soon", unknown: undefined });
    for (const threadId of ["past", "garbled", "unknown"]) hold.hold(threadId);
    expect(["past", "garbled", "unknown"].some((threadId) => hold.holds(threadId))).toBe(false);
    expect(hold.waiting()).toEqual({});
    vi.runAllTimers();
    expect(wake).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("tries again a minute later when the dog has no free slot, unless the conversation runs first", () => {
    const { hold, wake } = setup({});
    hold.retry("thread-1");
    hold.retry("thread-2");
    vi.advanceTimersByTime(RECHECK_MS - 1);
    hold.release("thread-2");
    expect(wake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(wake).toHaveBeenCalledExactlyOnceWith("thread-1");
    vi.runAllTimers();
    expect(wake).toHaveBeenCalledOnce();
  });
});
