// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProfileBridge } from "./ProfileSwitcher";

const store = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, config: { profile: { name: "Anthony" } } }, dispatch: store.dispatch }),
  };
});

import { SidebarProfileMenu } from "./SidebarProfileMenu";

const BUSINESS = "p00000000000a";
const SECOND = "p00000000000b";

const listOf = (activeId: string, profiles: DesktopProfile[]): DesktopProfileList => ({ activeId, canAdd: true, profiles });
const PERSONAL: DesktopProfile = { id: "main", name: "", main: true, status: "running" };
const THREE = listOf(BUSINESS, [
  PERSONAL,
  { id: BUSINESS, name: "Business", main: false, status: "running" },
  { id: SECOND, name: "Business 2", main: false, status: "running" },
]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function bridgeFor(list: DesktopProfileList, overrides: Partial<ProfileBridge> = {}): ProfileBridge {
  return {
    list: vi.fn(async () => list),
    add: vi.fn(async () => ({ ...list, added: { id: "p00000000000d", ready: true } })),
    switch: vi.fn(async () => list),
    rename: vi.fn(async () => list),
    remove: vi.fn(async () => list),
    onChanged: vi.fn(() => () => {}),
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.reducedMotion = "true";
  store.dispatch.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  delete document.documentElement.dataset.reducedMotion;
  vi.unstubAllGlobals();
});

async function show(bridge: ProfileBridge | undefined) {
  vi.stubGlobal("laterdog", bridge ? { profiles: bridge } : undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(SidebarProfileMenu)));
}

const trigger = () => host!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const menu = () => host!.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
const labels = () => items().map((item) => item.querySelector(".truncate")?.textContent);
const item = (label: string) => items().find((element) => element.querySelector(".truncate")?.textContent === label);
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
};
const escape = async () => {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
};
const openProfiles = async () => {
  await click(trigger());
  await click(item("Switch profile"));
};

describe("switching profiles from the name menu", () => {
  it("is not offered without the desktop app's profiles", async () => {
    await show(undefined);
    await click(trigger());
    expect(labels()).not.toContain("Switch profile");
  });

  it("comes first, and the open profile is named under the person's name once there is more than one", async () => {
    await show(bridgeFor(THREE));
    expect(trigger().textContent).toBe("AAnthonyBusiness");
    await click(trigger());
    expect(labels()[0]).toBe("Switch profile");
  });

  it("keeps the name alone while Personal is the only profile", async () => {
    await show(bridgeFor(listOf("main", [PERSONAL])));
    expect(trigger().textContent).toBe("AAnthony");
    await click(trigger());
    expect(labels()[0]).toBe("Switch profile");
  });

  it("turns the menu into the profile list in place, and Back or reopening returns to the menu", async () => {
    await show(bridgeFor(THREE));
    await openProfiles();
    expect(menu()).toBeTruthy();
    expect(labels()).toEqual(["Back", "Personal", "Business", "Business 2", "Add profile", "Edit profiles"]);
    expect(document.activeElement).toBe(item("Back"));
    await click(item("Back"));
    expect(labels()[0]).toBe("Switch profile");
    expect(document.activeElement).toBe(item("Switch profile"));
    await click(item("Switch profile"));
    await escape();
    expect(menu()).toBeNull();
    await click(trigger());
    expect(labels()[0]).toBe("Switch profile");
  });

  it("spins on the chosen profile and leaves a failure on its row", async () => {
    const opening = deferred<DesktopProfileList>();
    const bridge = bridgeFor(THREE, { switch: vi.fn(() => opening.promise) });
    await show(bridge);
    await openProfiles();
    await click(item("Business 2"));
    expect(bridge.switch).toHaveBeenCalledWith(SECOND);
    expect(menu()).toBeTruthy();
    expect(item("Business 2")!.disabled).toBe(true);
    expect(item("Business 2")!.querySelector(".animate-spin")).toBeTruthy();
    expect(item("Add profile")!.disabled).toBe(true);
    await act(async () => opening.reject(new Error("Error invoking remote method 'profiles:switch': Error: Business 2 could not start")));
    expect(item("Business 2")!.disabled).toBe(false);
    expect(item("Business 2")!.textContent).toContain("Business 2 could not start");
    expect(store.dispatch).not.toHaveBeenCalled();
  });

  it("choosing the open profile just closes the menu", async () => {
    const bridge = bridgeFor(THREE);
    await show(bridge);
    await openProfiles();
    await click(item("Business"));
    expect(bridge.switch).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it("reports a failure on the page when the menu was closed meanwhile", async () => {
    const opening = deferred<DesktopProfileList>();
    await show(bridgeFor(THREE, { switch: vi.fn(() => opening.promise) }));
    await openProfiles();
    await click(item("Business 2"));
    await escape();
    expect(menu()).toBeNull();
    await act(async () => opening.reject(new Error("Error invoking remote method 'profiles:switch': Error: Business 2 could not start")));
    expect(store.dispatch).toHaveBeenCalledWith({ type: "error", message: "Business 2 could not start" });
  });

  it("only the last of two quick choices settles the spinner", async () => {
    const first = deferred<DesktopProfileList>();
    const second = deferred<DesktopProfileList>();
    const switchTo = vi.fn<ProfileBridge["switch"]>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await show(bridgeFor(THREE, { switch: switchTo }));
    await openProfiles();
    await click(item("Business 2"));
    await click(item("Personal"));
    await act(async () => first.reject(new Error("superseded")));
    expect(item("Personal")!.querySelector(".animate-spin")).toBeTruthy();
    expect(item("Business 2")!.textContent).not.toContain("superseded");
    await act(async () => second.resolve(THREE));
    expect(item("Personal")!.querySelector(".animate-spin")).toBeNull();
  });

  it("opens Add and Edit in their own windows and returns focus to the name", async () => {
    await show(bridgeFor(THREE));
    await openProfiles();
    await click(item("Add profile"));
    expect(menu()).toBeNull();
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("Add a profile");
    await click([...document.querySelectorAll("button")].find((element) => element.textContent === "Cancel"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await openProfiles();
    await click(item("Edit profiles"));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("Edit profiles");
  });
});
