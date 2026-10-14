// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({
  state: { status: "idle" } as UpdaterState,
  listeners: new Set<() => void>(),
  bots: [] as Array<{ name: string; busy?: boolean }>,
}));
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
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: fixture.bots }, dispatch: () => {} }) }));
vi.mock("../lib/brand", () => ({ brand: () => ({ name: "later.dog" }) }));
const links = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: links.open }));
import { dismissUpdateDialog, requestUpdateDialog } from "@/lib/update-request";
import { UpdateDialog, UpdatePill } from "./UpdateButton";

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
  act(() => dismissUpdateDialog());
  act(() => root.unmount());
  host.remove();
  fixture.state = { status: "idle" };
  fixture.bots = [];
  updater.check.mockClear();
  updater.install.mockClear();
  links.open.mockClear();
  Reflect.deleteProperty(window, "laterdog");
});

function mount(state: UpdaterState) {
  fixture.state = state;
  act(() => root.render(createElement("div", null, createElement(UpdatePill), createElement(UpdateDialog))));
}

function publish(state: UpdaterState) {
  act(() => {
    fixture.state = state;
    for (const listener of fixture.listeners) listener();
  });
}

const pill = () => host.querySelector<HTMLButtonElement>("[data-update-pill]");
const dialog = () => document.body.querySelector("[data-update-dialog]");
const buttonNamed = (name: string) => [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === name) ?? null;
const click = (element: HTMLElement | null) => act(() => element?.click());

describe("the update pill in use", () => {
  it("turns from a quiet download line into the blue Update button, and back to nothing when done", () => {
    mount({ status: "downloading", version: "0.3.4", percent: 10 });
    expect(pill()?.getAttribute("data-update-kind")).toBe("quiet");
    expect(pill()?.textContent).toContain("Downloading update… 10%");
    publish({ status: "downloading", version: "0.3.4", percent: 75 });
    expect(pill()?.textContent).toContain("75%");
    publish({ status: "downloaded", version: "0.3.4" });
    expect(pill()?.getAttribute("data-update-kind")).toBe("update");
    expect(pill()?.textContent).toBe("Update");
    publish({ status: "idle" });
    expect(pill()).toBeNull();
  });

  it("asks before restarting, naming the version, and restarts once", () => {
    mount({ status: "downloaded", version: "0.3.4" });
    expect(dialog()).toBeNull();
    click(pill());
    expect(dialog()?.textContent).toContain("Update to later.dog 0.3.4?");
    expect(updater.install).not.toHaveBeenCalled();
    click(buttonNamed("Update and restart"));
    expect(updater.install).toHaveBeenCalledTimes(1);
    expect(buttonNamed("Restarting…")?.disabled).toBe(true);
    publish({ status: "error", message: "Native staging failed" });
    const retry = buttonNamed("Try again");
    expect(retry?.disabled).toBe(false);
    click(retry);
    expect(updater.check).toHaveBeenCalledTimes(1);
  });

  it("opens from the account menu row too, and keeps the update waiting after Later", () => {
    mount({ status: "downloaded", version: "0.3.4" });
    act(() => requestUpdateDialog());
    expect(dialog()).not.toBeNull();
    click(buttonNamed("Later"));
    expect(dialog()).toBeNull();
    expect(pill()?.getAttribute("data-update-kind")).toBe("update");
    expect(updater.install).not.toHaveBeenCalled();
  });

  it("lists the dogs still working on one line", () => {
    fixture.bots = [{ name: "Pepper", busy: true }];
    mount({ status: "downloaded", version: "0.3.4" });
    click(pill());
    expect(dialog()?.querySelector("[data-update-warning]")?.textContent).toBe("Pepper is still working. Restarting now interrupts it.");
  });

  it("closes the dialog by itself when the update goes away", () => {
    mount({ status: "downloaded", version: "0.3.4" });
    click(pill());
    publish({ status: "idle" });
    expect(dialog()).toBeNull();
    publish({ status: "downloaded", version: "0.3.5" });
    expect(dialog()).toBeNull();
  });

  it("retries a failed update straight from the pill, and offers the download page in the dialog", () => {
    mount({ status: "error", message: "Code signature did not pass validation" });
    click(pill());
    expect(updater.check).toHaveBeenCalledTimes(1);
    act(() => requestUpdateDialog());
    const link = document.body.querySelector<HTMLButtonElement>("[data-update-download]");
    expect(link?.textContent).toBe("Or download the newest version from later.dog");
    click(link);
    expect(links.open).toHaveBeenCalledExactlyOnceWith("https://later.dog");
    expect(dialog()).toBeNull();
  });

  it("sends a release this build cannot install to its download page", () => {
    mount({ status: "idle", releaseCheck: "on", available: { version: "0.3.4", url: "https://github.com/woodbeary/later-dog/releases/tag/v0.3.4" } });
    click(pill());
    expect(links.open).toHaveBeenCalledExactlyOnceWith("https://github.com/woodbeary/later-dog/releases/tag/v0.3.4");
    expect(dialog()).toBeNull();
  });
});
