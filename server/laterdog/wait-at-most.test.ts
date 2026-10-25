import { afterEach, describe, expect, it, vi } from "vitest";
import { readEngineModels, waitAtMost } from "./wait-at-most.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("waitAtMost", () => {
  it("returns as soon as quick work settles", async () => {
    const started = Date.now();
    await waitAtMost(Promise.resolve("done"), 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("stops waiting on slow work and lets it finish behind", async () => {
    vi.useFakeTimers();
    let finished = false;
    const slow = new Promise<void>((resolve) => setTimeout(() => { finished = true; resolve(); }, 10_000));
    let waited = false;
    const wait = waitAtMost(slow, 300).then(() => { waited = true; });
    await vi.advanceTimersByTimeAsync(299);
    expect(waited).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(waited).toBe(true);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finished).toBe(true);
  });

  it("never fails when the work does", async () => {
    await expect(waitAtMost(Promise.reject(new Error("no catalog")), 300)).resolves.toBeUndefined();
  });
});

describe("reading an engine's models while a Cloud home starts", () => {
  it("waits for the read once the home has settled", async () => {
    let read = false;
    await readEngineModels(async () => { read = true; }, { quietMs: 30_000, upMs: () => 45_000 });
    expect(read).toBe(true);
  });

  it("starts the read only once the home has been up a while, so the first requests after a wake are not slowed", async () => {
    vi.useFakeTimers();
    let reads = 0;
    await readEngineModels(async () => { reads += 1; }, { quietMs: 30_000, upMs: () => 5_000 });
    expect(reads).toBe(0);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(reads).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(1);
  });
});

