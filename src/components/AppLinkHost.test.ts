// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "@/state/store";

const store = vi.hoisted(() => ({ state: null as unknown as AppState, dispatch: vi.fn() }));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  store.state = original.initialState;
  return { ...original, useStore: () => ({ state: store.state, dispatch: store.dispatch }) };
});

const { AppLinkHost } = await import("./AppLinkHost");

let host: HTMLDivElement;
let root: Root;
let deliver: ((url: string) => void) | null;
let unsubscribed: number;

function roster(patch: Partial<AppState>): AppState {
  return {
    ...store.state,
    hydrated: true,
    bots: [{ id: "boat" }, { id: "kite" }] as AppState["bots"],
    groups: [{ id: "g-team" }] as AppState["groups"],
    selectedId: "boat",
    ...patch,
  };
}

async function render() {
  await act(async () => root.render(createElement(AppLinkHost)));
}

async function send(url: string) {
  await act(async () => deliver?.(url));
}

const dialog = () => document.querySelector<HTMLElement>("[role='alertdialog']");

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const original = await vi.importActual<typeof import("@/state/store")>("@/state/store");
  store.state = { ...original.initialState };
  store.dispatch = vi.fn();
  deliver = null;
  unsubscribed = 0;
  vi.stubGlobal("laterdog", {
    onAppLink: (cb: (url: string) => void) => {
      deliver = cb;
      return () => { unsubscribed += 1; };
    },
  });
  window.laterdog = (globalThis as unknown as { laterdog: typeof window.laterdog }).laterdog;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.laterdog = undefined;
  vi.unstubAllGlobals();
});

describe("app links in the window", () => {
  it("holds a cold-start link until the dogs are loaded, then opens that dog", async () => {
    await render();
    await send("laterdog://chat/kite?thread=old-thread");
    expect(store.dispatch).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    store.state = roster({});
    await render();
    expect(store.dispatch.mock.calls).toEqual([[{ type: "select", id: "kite" }]]);
  });

  it("closes Settings to show the linked dog", async () => {
    store.state = roster({ appSettingsOpen: true });
    await render();
    await send("laterdog://dog/g-team");
    expect(store.dispatch.mock.calls).toEqual([
      [{ type: "toggleAppSettings", open: false }],
      [{ type: "select", id: "g-team" }],
    ]);
  });

  it("opens the linked Settings section, and the top of Settings for one it does not know", async () => {
    store.state = roster({});
    await render();
    await send("laterdog://settings?section=usage");
    await send("laterdog://settings?section=passkeys");
    expect(store.dispatch.mock.calls).toEqual([
      [{ type: "toggleAppSettings", open: true, section: "usage" }],
      [{ type: "toggleAppSettings", open: true, section: "general" }],
    ]);
  });

  it("shows Not found for a missing dog over the open conversation, and Close dismisses it", async () => {
    store.state = roster({});
    await render();
    await send("laterdog://dog/gone");
    expect(store.dispatch).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("Not found");
    expect(dialog()?.textContent).toContain("This dog was removed or isn't shared with you.");
    expect(host.contains(dialog())).toBe(false);
    const close = [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === "Close")!;
    expect(document.activeElement).toBe(close);
    await act(async () => close.click());
    expect(dialog()).toBeNull();
  });

  it("Escape closes Not found and nothing else hears it", async () => {
    const appKeys: string[] = [];
    const appListener = (event: KeyboardEvent) => appKeys.push(event.key);
    window.addEventListener("keydown", appListener);
    store.state = roster({});
    await render();
    await send("laterdog://dog/gone");
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog()).toBeNull();
    expect(appKeys).toEqual([]);
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(appKeys).toEqual(["Escape"]);
    window.removeEventListener("keydown", appListener);
  });

  it("ignores malformed links", async () => {
    store.state = roster({});
    await render();
    await send("laterdog://chat/");
    await send("laterdog://nope/boat");
    await send("not a link");
    expect(store.dispatch).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("stops listening when the window unmounts", async () => {
    await render();
    await act(async () => root.unmount());
    expect(unsubscribed).toBe(1);
    root = createRoot(host);
  });
});
