// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ state: { connected: false, hydrated: false, restored: false } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state }) }));
vi.mock("@/components/DogAvatar", () => ({ BreedAvatar: () => null }));
import { LaunchSplash } from "./LaunchSplash";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  fixture.state = { connected: false, hydrated: false, restored: false };
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.reducedMotion;
  vi.useRealTimers();
});

const splash = () => host.querySelector("[data-launch-splash]");
const render = () => act(() => root.render(createElement(LaunchSplash)));

describe("the launch splash", () => {
  it("shows the ready app immediately on a first launch", () => {
    fixture.state = { connected: true, hydrated: true, restored: false };
    render();
    expect(splash()).toBeNull();
  });

  it("uncovers the app as soon as its first data arrives", () => {
    render();
    expect(splash()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(50); });
    fixture.state = { connected: true, hydrated: true, restored: false };
    render();
    expect(splash()).toBeNull();
  });

  it("keeps the loading cover until data is ready, even after a long connection failure", () => {
    render();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(splash()).not.toBeNull();
    fixture.state = { connected: true, hydrated: false, restored: false };
    render();
    expect(splash()).not.toBeNull();
    fixture.state = { connected: true, hydrated: true, restored: false };
    render();
    expect(splash()).toBeNull();
  });

  it("never shows when the last sidebar was painted from the saved copy", () => {
    fixture.state = { connected: false, hydrated: false, restored: true };
    render();
    expect(splash()).toBeNull();
  });

  it("does not cover an app that was already ready when a connection is lost", () => {
    fixture.state = { connected: true, hydrated: true, restored: false };
    render();
    act(() => { vi.advanceTimersByTime(2_000); });
    act(() => { vi.advanceTimersByTime(2_000); });
    fixture.state = { connected: false, hydrated: false, restored: false };
    render();
    expect(splash()).toBeNull();
  });

  it("uncovers ready content without an animation delay with reduced motion", () => {
    document.documentElement.dataset.reducedMotion = "true";
    render();
    expect(splash()).not.toBeNull();
    fixture.state = { connected: true, hydrated: true, restored: false };
    render();
    expect(splash()).toBeNull();
  });
});
