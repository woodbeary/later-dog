import { describe, expect, it } from "vitest";
import { createIdleReload } from "./idle-reload.ts";

function fixture(forceAfterMs = 60_000) {
  const state = { busy: false, at: 0, reloads: 0, tick: null as null | (() => void), stopped: 0 };
  const reload = createIdleReload({
    busy: () => state.busy,
    reload: async () => { state.reloads += 1; },
    forceAfterMs,
    pollMs: 1_000,
    now: () => state.at,
    every: (run) => { state.tick = run; return { stop: () => { state.stopped += 1; state.tick = null; } }; },
  });
  return { state, reload };
}

describe("applying engine settings without cutting turns off", () => {
  it("applies at once when nothing is running", async () => {
    const { state, reload } = fixture();
    await reload.request();
    expect(state.reloads).toBe(1);
    expect(reload.waiting()).toBe(false);
  });

  it("waits for running turns, then applies once when they finish", async () => {
    const { state, reload } = fixture();
    state.busy = true;
    await reload.request();
    await reload.request();
    expect(state.reloads).toBe(0);
    expect(reload.waiting()).toBe(true);
    state.tick!();
    expect(state.reloads).toBe(0);
    state.busy = false;
    await reload.check();
    expect(state.reloads).toBe(1);
    expect(reload.waiting()).toBe(false);
    expect(state.stopped).toBe(1);
    expect(reload.check()).toBeNull();
  });

  it("applies anyway once turns have run past the longest wait", async () => {
    const { state, reload } = fixture(60_000);
    state.busy = true;
    await reload.request();
    state.at = 59_999;
    expect(reload.check()).toBeNull();
    state.at = 60_000;
    await reload.check();
    expect(state.reloads).toBe(1);
  });
});
