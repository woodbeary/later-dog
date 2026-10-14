import { afterEach, describe, expect, it, vi } from "vitest";
import { retryUntilDone } from "./retry-until.ts";

afterEach(() => { vi.useRealTimers(); });

describe("trying again until it works", () => {
  it("tries every interval until the attempt stops throwing, then stops", () => {
    vi.useFakeTimers();
    const attempt = vi.fn<() => void>()
      .mockImplementationOnce(() => { throw new Error("still full"); })
      .mockImplementationOnce(() => { throw new Error("still full"); })
      .mockImplementation(() => {});
    retryUntilDone(attempt, { everyMs: 1_000, forMs: 60_000 });
    expect(attempt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    expect(attempt).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(10_000);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("gives up with the last error once the time is spent", () => {
    vi.useFakeTimers();
    const onGiveUp = vi.fn();
    const attempt = vi.fn(() => { throw new Error("always"); });
    retryUntilDone(attempt, { everyMs: 1_000, forMs: 3_500, onGiveUp });
    vi.advanceTimersByTime(20_000);
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0]![0]).toEqual(new Error("always"));
  });
});
