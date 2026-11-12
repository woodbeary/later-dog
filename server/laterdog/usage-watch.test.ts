import { describe, expect, it, vi } from "vitest";
import { createUsageWatch, planUsageWatch, USAGE_REFRESH_MS } from "./usage-watch.ts";

const NOW = Date.parse("2026-11-08T19:02:50Z");

describe("deciding what the home checks while chats wait for usage", () => {
  it("reads usage only when something waits and the last reading is old enough", () => {
    expect(planUsageWatch({ held: [], stranded: [], lastRefreshAt: undefined, now: NOW })).toEqual({ refresh: false, wake: [] });
    expect(planUsageWatch({ held: ["a"], stranded: [], lastRefreshAt: undefined, now: NOW }).refresh).toBe(true);
    expect(planUsageWatch({ held: ["a"], stranded: [], lastRefreshAt: NOW - USAGE_REFRESH_MS + 1, now: NOW }).refresh).toBe(false);
    expect(planUsageWatch({ held: [], stranded: ["b"], lastRefreshAt: NOW - USAGE_REFRESH_MS, now: NOW }).refresh).toBe(true);
  });

  it("wakes a stranded chat once, and leaves chats the hold already times", () => {
    expect(planUsageWatch({ held: ["a"], stranded: ["a", "b", "b"], lastRefreshAt: NOW, now: NOW }).wake).toEqual(["b"]);
  });
});

describe("the usage watch with no app connected", () => {
  it("re-reads usage, rechecks held chats and wakes a chat nobody was timing", async () => {
    let now = NOW;
    const refresh = vi.fn(async () => {});
    const recheck = vi.fn();
    const wake = vi.fn();
    const watch = createUsageWatch({ held: () => ["held"], stranded: () => ["stuck"], refresh, recheck, wake, now: () => now, log: () => {} });
    await watch.tick();
    expect(refresh).toHaveBeenCalledOnce();
    expect(recheck).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledExactlyOnceWith("stuck");
    now += 60_000;
    await watch.tick();
    expect(refresh).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledTimes(2);
    now += USAGE_REFRESH_MS;
    await watch.tick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("still rechecks and wakes when reading usage fails", async () => {
    const recheck = vi.fn();
    const wake = vi.fn();
    const lines: string[] = [];
    const watch = createUsageWatch({ held: () => [], stranded: () => ["stuck"], refresh: async () => { throw new Error("offline"); }, recheck, wake, now: () => NOW, log: (line) => lines.push(line) });
    await watch.tick();
    expect(recheck).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledWith("stuck");
    expect(lines.some((line) => line.includes("offline"))).toBe(true);
  });

  it("does nothing while no chat waits", async () => {
    const refresh = vi.fn(async () => {});
    const wake = vi.fn();
    const watch = createUsageWatch({ held: () => [], stranded: () => [], refresh, recheck: vi.fn(), wake, now: () => NOW, log: () => {} });
    await watch.tick();
    expect(refresh).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("runs one check at a time", async () => {
    let release = () => {};
    const refresh = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const watch = createUsageWatch({ held: () => ["a"], stranded: () => [], refresh, recheck: vi.fn(), wake: vi.fn(), now: () => NOW, log: () => {} });
    const first = watch.tick();
    const second = watch.tick();
    expect(second).toBe(first);
    release();
    await first;
    expect(refresh).toHaveBeenCalledOnce();
  });
});
