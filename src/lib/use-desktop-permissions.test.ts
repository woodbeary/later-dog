import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopPermissionChecklist } from "./desktop-permissions";

// The hook under a counting useState and a captured useEffect, the way the
// other hook recipes here run: no DOM, every effect run by hand.
const fixture = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: (effect: () => void | (() => void)) => {
    fixture.effects.push(effect);
  },
  useCallback: (callback: unknown) => callback,
}));
import { useDesktopPermissions } from "./use-desktop-permissions";

const granted: DesktopPermissionChecklist = { microphone: "granted", accessibility: "granted", screen: "granted" };
const listeners = new Map<string, Array<() => void>>();
function page(laterdog: unknown) {
  listeners.clear();
  vi.stubGlobal("window", {
    laterdog,
    addEventListener: (name: string, handler: () => void) => listeners.set(name, [...(listeners.get(name) ?? []), handler]),
    removeEventListener: (name: string, handler: () => void) => listeners.set(name, (listeners.get(name) ?? []).filter((h) => h !== handler)),
  });
  vi.stubGlobal("document", { visibilityState: "visible" });
}
function render(options?: { active?: boolean; intervalMs?: number }) {
  fixture.index = 0;
  fixture.effects = [];
  return useDesktopPermissions(options);
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  fixture.values = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useDesktopPermissions", () => {
  it("reads the checklist once, then on every tick and window focus, and stops on cleanup", async () => {
    const status = vi.fn(async () => ({ ...granted, screen: "denied" }));
    page({ permissions: { status, request: vi.fn(), openSettings: vi.fn() } });
    expect(render().checklist).toBeNull();
    const cleanup = fixture.effects[0]!();
    await flush();
    expect(status).toHaveBeenCalledTimes(1);
    expect(render().checklist).toEqual({ ...granted, screen: "denied" });
    vi.advanceTimersByTime(2000);
    await flush();
    expect(status).toHaveBeenCalledTimes(2);
    for (const handler of listeners.get("focus") ?? []) handler();
    await flush();
    expect(status).toHaveBeenCalledTimes(3);
    (cleanup as () => void)();
    vi.advanceTimersByTime(10_000);
    expect(status).toHaveBeenCalledTimes(3);
    expect(listeners.get("focus")).toEqual([]);
  });

  it("asks the bridge for nothing without it, or while inactive", async () => {
    page({});
    render();
    fixture.effects[0]!();
    await flush();
    expect(render().checklist).toBeNull();

    const status = vi.fn(async () => granted);
    page({ permissions: { status, request: vi.fn(), openSettings: vi.fn() } });
    fixture.values = [];
    render({ active: false });
    fixture.effects[0]!();
    await flush();
    expect(status).not.toHaveBeenCalled();
  });

  it("marks the grant being asked for and keeps the bridge's answer to it", async () => {
    const request = vi.fn(async () => ({ ...granted, accessibility: "denied" }));
    const openSettings = vi.fn(async () => true);
    page({ permissions: { status: vi.fn(async () => granted), request, openSettings } });
    const pending = render().request("screen");
    expect(render().busy).toBe("screen");
    await pending;
    expect(request).toHaveBeenCalledWith("screen");
    const after = render();
    expect(after.busy).toBeNull();
    expect(after.checklist).toEqual({ ...granted, accessibility: "denied" });
    await after.openSettings("microphone");
    expect(openSettings).toHaveBeenCalledWith("microphone");
  });

  it("falls back to a fresh read when the prompt itself fails, and reads garbage as unavailable", async () => {
    const status = vi.fn(async () => ({ microphone: "granted" }));
    const request = vi.fn(async () => { throw new Error("no TCC"); });
    page({ permissions: { status, request, openSettings: vi.fn() } });
    await render().request("microphone");
    expect(status).toHaveBeenCalledTimes(1);
    expect(render().checklist).toEqual({ microphone: "granted", accessibility: "unavailable", screen: "unavailable" });
  });
});
