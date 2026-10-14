// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  document.documentElement.dataset.reducedMotion = "true";
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
  delete document.documentElement.dataset.reducedMotion;
  vi.unstubAllGlobals();
});

async function drawOpen(items: SidebarMenuItem[]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(SidebarPopoverMenu, { items, ariaLabel: "Menu", renderTrigger: () => "Menu" })));
  await act(async () => host!.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]")!.click());
}

const plain = (key: string): SidebarMenuItem => ({ key, label: key, onSelect: () => {} });
const withFlyout = (onClose: (close: () => void) => void): SidebarMenuItem => ({
  key: "usage",
  label: "Usage",
  onSelect: () => {},
  submenu: (close) => createElement("button", { role: "menuitem", "data-inside": "", onClick: () => onClose(close) }, "Manage usage"),
});

const row = (key: string) => [...document.body.querySelectorAll<HTMLElement>("[role=menuitem]")].find((node) => node.textContent?.includes(key))!.parentElement!;

describe("a menu row with a submenu", () => {
  it("opens beside the row after a short pause on hover, and closes after the pointer leaves", async () => {
    await drawOpen([plain("Settings"), withFlyout(() => {})]);
    expect(document.body.querySelector("[data-menu-flyout]")).toBeNull();
    await act(async () => { row("Usage").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); vi.advanceTimersByTime(120); });
    expect(document.body.querySelector("[data-menu-flyout] [data-inside]")?.textContent).toBe("Manage usage");
    expect(row("Usage").querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    await act(async () => { row("Usage").dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })); vi.advanceTimersByTime(400); });
    expect(document.body.querySelector("[data-menu-flyout]")).toBeNull();
  });

  it("closes when the pointer moves on to another row", async () => {
    await drawOpen([withFlyout(() => {}), plain("Settings")]);
    await act(async () => { row("Usage").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); vi.advanceTimersByTime(120); });
    expect(document.body.querySelector("[data-menu-flyout]")).not.toBeNull();
    await act(async () => { row("Settings").dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); vi.advanceTimersByTime(400); });
    expect(document.body.querySelector("[data-menu-flyout]")).toBeNull();
  });

  it("opens on a click for keyboards and touch, and hands the submenu a way to close the whole menu", async () => {
    const chosen = vi.fn();
    await drawOpen([withFlyout((close) => { chosen(); close(); })]);
    await act(async () => row("Usage").querySelector<HTMLButtonElement>("button")!.click());
    expect(document.body.querySelector("[data-menu-flyout]")).not.toBeNull();
    await act(async () => document.body.querySelector<HTMLButtonElement>("[data-inside]")!.click());
    expect(chosen).toHaveBeenCalledOnce();
    expect(document.body.querySelector("[role=menu][aria-label=Menu]")).toBeNull();
  });
});
