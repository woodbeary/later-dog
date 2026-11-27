import { describe, expect, it, vi } from "vitest";

import { createGracefulShutdown } from "./graceful-shutdown.ts";

describe("createGracefulShutdown", () => {
  it("waits for capability and provider cleanup and only starts once", async () => {
    let finishCapabilities!: () => void;
    let finishProviders!: () => void;
    const capabilities = new Promise<void>((resolve) => { finishCapabilities = resolve; });
    const providers = new Promise<void>((resolve) => { finishProviders = resolve; });
    const capabilityCleanup = vi.fn(() => capabilities);
    const providerCleanup = vi.fn(() => providers);
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      cleanup: [capabilityCleanup, providerCleanup],
      exit,
      timeoutMs: 5_000,
    });

    shutdown();
    shutdown();
    await Promise.resolve();
    expect(capabilityCleanup).toHaveBeenCalledOnce();
    expect(providerCleanup).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    finishCapabilities();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    finishProviders();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("uses the deadline when cleanup is wedged", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const shutdown = createGracefulShutdown({
        cleanup: [() => new Promise<void>(() => {})],
        exit,
        timeoutMs: 50,
      });
      shutdown();
      await vi.advanceTimersByTimeAsync(49);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a server stopping for a code switch", () => {
  it("finishes the steps that save data, gives the rest a short courtesy window, and says what it left", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const lines: string[] = [];
      let saved = false;
      const shutdown = createGracefulShutdown({
        cleanup: [{ name: "flush journals", run: async () => { await new Promise((resolve) => setTimeout(resolve, 300)); saved = true; } }],
        courtesy: [{ name: "close engines", run: () => new Promise<void>(() => {}) }],
        exit,
        log: (line) => lines.push(line),
        now: () => Date.now(),
      });
      shutdown();
      await vi.advanceTimersByTimeAsync(299);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(saved).toBe(true);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(450);
      expect(exit).toHaveBeenCalledWith(0);
      expect(lines).toEqual(["shutdown: flush journals took 300 ms", "shutdown: left close engines unfinished after 750 ms"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exits as soon as everything is done, without waiting out the courtesy window", async () => {
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ cleanup: [() => {}], courtesy: [async () => {}], exit });
    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });
});
