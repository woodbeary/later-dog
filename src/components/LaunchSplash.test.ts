// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ state: { connected: false, hydrated: false } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state }) }));
vi.mock("@/components/DogAvatar", () => ({ BreedAvatar: () => null }));
import { LaunchSplash, SPLASH_FADE_MS, SPLASH_MIN_MS } from "./LaunchSplash";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const splash = () => host.querySelector("[data-launch-splash]")?.getAttribute("data-launch-splash") ?? null;

describe("the launch splash", () => {
  it("stays at least its minimum even when the app is ready at once, then fades out", () => {
    fixture.state = { connected: true, hydrated: true };
    act(() => root.render(createElement(LaunchSplash)));
    expect(splash()).toBe("shown");
    act(() => { vi.advanceTimersByTime(SPLASH_MIN_MS); });
    expect(splash()).toBe("leaving");
    act(() => { vi.advanceTimersByTime(SPLASH_FADE_MS); });
    expect(splash()).toBeNull();
  });

  it("waits for a slow start before leaving", () => {
    fixture.state = { connected: false, hydrated: false };
    act(() => root.render(createElement(LaunchSplash)));
    act(() => { vi.advanceTimersByTime(SPLASH_MIN_MS * 5); });
    expect(splash()).toBe("shown");
    fixture.state = { connected: true, hydrated: true };
    act(() => root.render(createElement(LaunchSplash)));
    expect(splash()).toBe("leaving");
  });
});
