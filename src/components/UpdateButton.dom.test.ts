// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: { status: "idle" } as UpdaterState, listeners: new Set<() => void>() }));
vi.mock("@/lib/updater", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useUpdaterState: () =>
      useSyncExternalStore(
        (listener: () => void) => {
          fixture.listeners.add(listener);
          return () => void fixture.listeners.delete(listener);
        },
        () => fixture.state,
      ),
  };
});
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: [] }, dispatch: () => {} }) }));
vi.mock("../lib/brand", () => ({ brand: () => ({ name: "later.dog" }) }));
import { UpdateButton } from "./UpdateButton";

const updater = { check: vi.fn(async () => {}), install: vi.fn(async () => {}), onState: () => () => {} };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { laterdog: { updater } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  fixture.state = { status: "idle" };
  updater.check.mockClear();
  updater.install.mockClear();
  Reflect.deleteProperty(window, "laterdog");
});

function mount(state: UpdaterState) {
  fixture.state = state;
  act(() => root.render(createElement(UpdateButton)));
}

function publish(state: UpdaterState) {
  act(() => {
    fixture.state = state;
    for (const listener of fixture.listeners) listener();
  });
}

const icon = () => host.querySelector<HTMLButtonElement>("[data-update-button]");
const popover = () => host.querySelector("[data-update-popover]:not([inert])");
const buttonNamed = (name: string) => [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === name) ?? null;
const click = (element: HTMLElement | null) => act(() => element?.click());

describe("the update icon in use", () => {
  it("opens only when clicked, and stays closed when it comes back", () => {
    mount({ status: "downloaded", version: "0.3.4" });
    expect(icon()?.getAttribute("aria-expanded")).toBe("false");
    expect(popover()).toBeNull();
    click(icon());
    expect(icon()?.getAttribute("aria-expanded")).toBe("true");
    expect(popover()?.textContent).toContain("Restart to update");
    publish({ status: "idle" });
    expect(icon()).toBeNull();
    publish({ status: "downloaded", version: "0.3.5" });
    expect(icon()?.getAttribute("aria-expanded")).toBe("false");
    expect(popover()).toBeNull();
  });

  it("follows the download live while the popover is open", () => {
    mount({ status: "downloading", version: "0.3.4", percent: 10 });
    click(icon());
    expect(popover()?.textContent).toContain("10% done.");
    publish({ status: "downloading", version: "0.3.4", percent: 75 });
    expect(popover()?.textContent).toContain("75% done.");
    publish({ status: "downloaded", version: "0.3.4" });
    expect(popover()?.textContent).toContain("later.dog 0.3.4 is ready");
    expect(buttonNamed("Restart to update")).not.toBeNull();
  });

  it("restarts once, and offers a retry when the restart fails", () => {
    mount({ status: "downloaded", version: "0.3.4" });
    click(icon());
    click(buttonNamed("Restart to update"));
    expect(updater.install).toHaveBeenCalledTimes(1);
    expect(buttonNamed("Restarting…")?.disabled).toBe(true);
    publish({ status: "error", message: "Native staging failed" });
    const retry = buttonNamed("Try again");
    expect(retry?.disabled).toBe(false);
    click(retry);
    expect(updater.check).toHaveBeenCalledTimes(1);
  });

  it("keeps the icon after Later, so the update waits for the person", () => {
    mount({ status: "downloaded", version: "0.3.4" });
    click(icon());
    click(buttonNamed("Later"));
    expect(icon()?.getAttribute("aria-expanded")).toBe("false");
    expect(popover()).toBeNull();
    expect(updater.install).not.toHaveBeenCalled();
  });
});
