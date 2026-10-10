// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

const entry = (label: string, extra: Partial<SidebarMenuItem> = {}): SidebarMenuItem => ({
  key: label,
  label,
  keepOpen: true,
  onSelect: () => {},
  ...extra,
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.reducedMotion = "true";
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  delete document.documentElement.dataset.reducedMotion;
  vi.unstubAllGlobals();
});

async function draw(items: SidebarMenuItem[], onOpenChange?: (open: boolean) => void) {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () =>
    root!.render(createElement(SidebarPopoverMenu, { items, ariaLabel: "Menu", onOpenChange, renderTrigger: () => "Menu" })),
  );
}

const trigger = () => host!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const row = (label: string) =>
  [...host!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((element) => element.textContent === label);
const press = async (element: HTMLElement | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => element!.click());
};

describe("the popover menu", () => {
  it("tells its owner when it opens and closes", async () => {
    const onOpenChange = vi.fn();
    await draw([entry("Settings", { keepOpen: false })], onOpenChange);
    await press(trigger());
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await press(row("Settings"));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(host!.querySelector('[role="menu"]')).toBeNull();
  });

  it("leaves focus where it is when it opens", async () => {
    await draw([entry("Settings")]);
    trigger().focus();
    await press(trigger());
    expect(row("Settings")).toBeTruthy();
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps focus on a row that is still there when the rows change", async () => {
    await draw([entry("Settings"), entry("About")]);
    await press(trigger());
    row("About")!.focus();
    await draw([entry("Settings"), entry("Update"), entry("About")]);
    expect(document.activeElement).toBe(row("About"));
  });

  it("moves focus to the first row it can take when the focused row goes away", async () => {
    await draw([entry("Switch profile"), entry("Settings")]);
    await press(trigger());
    row("Switch profile")!.focus();
    await draw([entry("Back", { disabled: true }), entry("Personal"), entry("Business")]);
    expect(document.activeElement).toBe(row("Personal"));
  });
});
