// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("./MenuMotion", () => ({ useMenuMotion: () => ({ shown: true, exitProps: {}, className: "animate-pop-in" }) }));
vi.mock("@/hooks/use-popover-dismiss", () => ({ usePopoverDismiss: () => {} }));
const { SidebarPopoverMenu } = await import("./SidebarPopoverMenu");

const styles = readFileSync(resolve("src/styles.css"), "utf8");
const sidebar = readFileSync(resolve("src/components/Sidebar.tsx"), "utf8");

function rule(selector: string): Record<string, string> {
  const body = styles.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]));
}

function drawMenu() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(SidebarPopoverMenu, {
    ariaLabel: "Menu",
    renderTrigger: () => "trigger",
    items: [
      { key: "a", heading: "Your dogs", label: "Settings", onSelect: () => {} },
      { key: "b", label: "Help", onSelect: () => {} },
    ],
  })));
  flushSync(() => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  return host;
}

describe("one popover menu look", () => {
  it("draws the menu at radius 12 with 6 padding, rows at 14/20 with 8/14 padding and a 12 gap, and the popover shadow", () => {
    expect(rule(".popover-menu")).toMatchObject({ "border-radius": "var(--radius-menu)", padding: "6px", "box-shadow": "var(--shadow-popover)" });
    expect(rule(".popover-menu-row")).toMatchObject({ padding: "8px 14px", gap: "12px", "font-size": "14px", "line-height": "20px", "border-radius": "var(--radius-row)" });
    expect(rule(".popover-menu-heading")).toMatchObject({ "font-size": "12px", "line-height": "16px", color: "var(--color-ink-secondary)" });
    expect(rule(".popover-menu-heading")["text-transform"]).toBeUndefined();
  });

  it("puts the sidebar's popover menu, its rows and its section headings in that look", () => {
    const host = drawMenu();
    const menu = host.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.classList).toContain("popover-menu");
    expect(menu.className).not.toMatch(/rounded-xl|shadow-2xl|uppercase/);
    for (const row of menu.querySelectorAll('[role="menuitem"]')) expect(row.classList).toContain("popover-menu-row");
    const heading = menu.querySelector<HTMLElement>(".popover-menu-heading")!;
    expect(heading.textContent).toBe("Your dogs");
    expect(heading.className).not.toMatch(/uppercase|tracking/);
  });

  it("pops in over 200 ms and out over 300 ms", () => {
    const tokens = readFileSync(resolve("src/tokens.css"), "utf8");
    expect(tokens).toMatch(/--duration-slow: 200ms;/);
    expect(tokens).toMatch(/--duration-exit: 300ms;/);
    expect(styles).toMatch(/--animate-pop-in: pop-in var\(--duration-slow\)/);
    expect(styles).toMatch(/--animate-pop-out: pop-out var\(--duration-exit\)/);
  });

  it("gives the sidebar's dog, room, folder and section menus the same look", () => {
    expect(sidebar).not.toMatch(/rounded-xl border border-hairline\/50 bg-menu/);
    expect(sidebar).not.toMatch(/px-3\.5 py-2 text-left text-\[1[34]px\]/);
    expect(sidebar.match(/popover-menu"|popover-menu /g)?.length).toBeGreaterThanOrEqual(4);
  });
});
