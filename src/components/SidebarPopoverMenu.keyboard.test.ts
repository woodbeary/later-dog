// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

let root: Root;
let host: HTMLDivElement;
const item = (key: string, extra: Partial<SidebarMenuItem> = {}): SidebarMenuItem => ({
  key,
  label: key,
  onSelect: () => {},
  ...extra,
});
const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="Menu"]')!;
const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const row = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent === name,
  )!;

async function draw(items: SidebarMenuItem[], portal = false) {
  await act(async () =>
    root.render(
      createElement(SidebarPopoverMenu, {
        items,
        portal,
        ariaLabel: "Menu",
        renderTrigger: () => "Menu",
      }),
    ),
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function key(element: HTMLElement, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  await act(async () => {
    element.dispatchEvent(event);
    if (
      !event.defaultPrevented &&
      (value === "Enter" || value === " ") &&
      element instanceof HTMLButtonElement
    )
      element.click();
    await vi.runOnlyPendingTimersAsync();
  });
  return event;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  document.documentElement.dataset.reducedMotion = "true";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete document.documentElement.dataset.reducedMotion;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("keyboard use of a popover menu", () => {
  it.each([false, true])(
    "returns focus to its trigger after Escape with portal=%s",
    async (portal) => {
      await draw([item("First"), item("Last")], portal);
      await click(trigger());
      row("Last").focus();
      await key(row("Last"), "Escape");
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger());
    },
  );

  it.each([
    ["ArrowDown", "First"],
    ["ArrowUp", "Last"],
    ["Enter", "First"],
    [" ", "First"],
  ])("opens from %s on its %s enabled row", async (pressed, focused) => {
    await draw([item("Disabled", { disabled: true }), item("First"), item("Last")]);
    trigger().focus();
    const event = await key(trigger(), pressed!);
    expect(menu()).toBeTruthy();
    expect(document.activeElement).toBe(row(focused!));
    expect(event.defaultPrevented).toBe(true);
  });

  it("moves through enabled rows and keeps navigation inside the menu", async () => {
    await draw([item("First"), item("Disabled", { disabled: true }), item("Middle"), item("Last")]);
    await click(trigger());
    row("First").focus();
    const leaked = vi.fn();
    window.addEventListener("keydown", leaked);
    try {
      for (const [pressed, focused] of [
        ["ArrowDown", "Middle"],
        ["End", "Last"],
        ["Home", "First"],
        ["ArrowUp", "Last"],
      ]) {
        const event = await key(document.activeElement as HTMLElement, pressed!);
        expect(document.activeElement).toBe(row(focused!));
        expect(event.defaultPrevented).toBe(true);
      }
      expect(leaked).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", leaked);
    }
  });

  it("moves between rows again when the trigger already has an open menu", async () => {
    await draw([item("First"), item("Last")]);
    await click(trigger());
    trigger().focus();
    await key(trigger(), "ArrowUp");
    expect(document.activeElement).toBe(row("Last"));
  });

  it("keeps submenu navigation in its own rows", async () => {
    const submenu = createElement(
      "div",
      null,
      createElement("button", { role: "menuitem" }, "Inside first"),
      createElement("button", { role: "menuitem", disabled: true }, "Inside disabled"),
      createElement("button", { role: "menuitem" }, "Inside last"),
    );
    await draw([item("Outer first"), item("Support", { submenu }), item("Outer last")]);
    await click(trigger());
    row("Support").focus();
    await key(row("Support"), "ArrowRight");
    expect(document.activeElement).toBe(row("Inside first"));
    const leaked = vi.fn();
    window.addEventListener("keydown", leaked);
    try {
      for (const [pressed, focused] of [
        ["End", "Inside last"],
        ["Home", "Inside first"],
        ["ArrowUp", "Inside last"],
      ]) {
        await key(document.activeElement as HTMLElement, pressed!);
        expect(document.activeElement).toBe(row(focused!));
      }
      expect(leaked).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", leaked);
    }
    await key(row("Inside last"), "ArrowLeft");
    expect(document.querySelector("[data-menu-flyout]")).toBeNull();
    expect(document.activeElement).toBe(row("Support"));
    expect(menu()).toBeTruthy();
  });

  it("closes a submenu first on Escape and keeps the parent open", async () => {
    await draw([
      item("Support", { submenu: createElement("button", { role: "menuitem" }, "Inside") }),
    ]);
    await click(trigger());
    row("Support").focus();
    await key(row("Support"), "ArrowRight");
    await key(row("Inside"), "Escape");
    expect(document.querySelector("[data-menu-flyout]")).toBeNull();
    expect(document.activeElement).toBe(row("Support"));
    expect(menu()).toBeTruthy();
  });
});
