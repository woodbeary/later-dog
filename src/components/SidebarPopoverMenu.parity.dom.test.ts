// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SKIN_IDS } from "../lib/skins";

vi.mock("./MenuMotion", () => ({ useMenuMotion: () => ({ shown: true, exitProps: {}, className: "animate-pop-in" }) }));
vi.mock("@/hooks/use-popover-dismiss", () => ({ usePopoverDismiss: () => {} }));
const { SidebarPopoverMenu } = await import("./SidebarPopoverMenu");

const styles = readFileSync(resolve("src/styles.css"), "utf8");
const sidebar = readFileSync(resolve("src/components/Sidebar.tsx"), "utf8");

function rule(selector: string): Record<string, string> {
  const body = styles.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]));
}

function skinTokens(id: string): Record<string, string> {
  const body = styles.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim().toLowerCase()]));
}

function themeTokens(): Record<string, string> {
  const body = styles.match(/@theme\s*\{([^}]*)\}/)?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim().toLowerCase()]));
}

type Rgb = [number, number, number];
function resolveColour(value: string, tokens: Record<string, string>): Rgb {
  const hex = /^#([0-9a-f]{6})$/.exec(value)?.[1];
  if (hex) return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb;
  const reference = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  if (reference) return resolveColour(tokens[reference]!, tokens);
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(value);
  if (mix) {
    const [first, second, share] = [resolveColour(mix[1]!, tokens), resolveColour(mix[3]!, tokens), Number(mix[2]) / 100];
    return first.map((channel, index) => channel * share + second[index]! * (1 - share)) as Rgb;
  }
  throw new Error(`cannot resolve colour ${value}`);
}

function contrast(first: Rgb, second: Rgb): number {
  const luminance = (rgb: Rgb) => {
    const [r, g, b] = rgb.map((channel) => (channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [high, low] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
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

  it("draws the highlighted row at least 1.10:1 from the menu in every skin, keeping Daylight and Midnight at the brief's fill", () => {
    const host = drawMenu();
    const active = host.querySelector<HTMLElement>('[role="menuitem"]')!;
    const rowToken = active.className.match(/(?:^|\s)hover:bg-([\w-]+)/)?.[1];
    expect(rowToken).toBeDefined();
    const menuToken = rule(".popover-menu")["background-color"]?.match(/var\(--color-([\w-]+)\)/)?.[1];
    expect(menuToken).toBeDefined();
    for (const skin of SKIN_IDS) {
      const tokens = { ...themeTokens(), ...skinTokens(skin) };
      const row = resolveColour(tokens[`--color-${rowToken}`]!, tokens);
      const menu = resolveColour(tokens[`--color-${menuToken}`]!, tokens);
      expect(contrast(row, menu), `${skin} row on menu`).toBeGreaterThanOrEqual(1.1);
    }
    expect(skinTokens("daylight")[`--color-${rowToken}`]).toBe("#eeeeee");
    expect(skinTokens("daylight")[`--color-${menuToken}`]).toBe("#ffffff");
    expect(skinTokens("midnight")[`--color-${rowToken}`]).toBe("#262626");
    expect(skinTokens("midnight")[`--color-${menuToken}`]).toBe("#1c1c1e");
  });

  it("highlights every row in the sidebar's own menus with the menu row colour, never the card fill", () => {
    const menuRows = sidebar.split("\n").filter((line) => line.includes("popover-menu-row") || /section === sectionCurrent|deleting \?/.test(line));
    expect(menuRows.length).toBeGreaterThanOrEqual(10);
    for (const line of menuRows) expect(line, line.trim()).not.toMatch(/bg-card/);
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
