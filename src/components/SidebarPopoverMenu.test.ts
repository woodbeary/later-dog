import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("./MenuMotion", () => ({ useMenuMotion: () => ({ shown: true, exitProps: {}, className: "" }) }));
vi.mock("@/hooks/use-popover-dismiss", () => ({ usePopoverDismiss: () => {} }));
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";

const render = (items: Parameters<typeof SidebarPopoverMenu>[0]["items"]) =>
  renderToStaticMarkup(createElement(SidebarPopoverMenu, { items, ariaLabel: "Menu", renderTrigger: () => "trigger" }));

it("draws an item's second line (where it connects) and third line (a note) under its label", () => {
  const html = render([
    { key: "cloud", label: "Connect your phone", subtitle: "to your Cloud (always on)", onSelect: () => {} },
    { key: "here", label: "Connect your phone", subtitle: "to this computer", note: "Your Cloud shows here once it is ready.", onSelect: () => {} },
    { key: "plain", label: "Settings", onSelect: () => {} },
  ]);
  expect(html).toMatch(/Connect your phone<\/span><span[^>]*>to your Cloud \(always on\)<\/span>/);
  expect(html).toMatch(/to this computer<\/span><span[^>]*>Your Cloud shows here once it is ready\.<\/span>/);
  expect(html.indexOf("to your Cloud (always on)")).toBeLessThan(html.indexOf("to this computer"));
  expect(html).toContain('<span class="flex-1 truncate">Settings</span>');
});

it("draws an item's attention dot on the item itself, in its tone", () => {
  const html = render([
    { key: "ready", label: "Restart to update", attention: true, attentionTone: "accent", onSelect: () => {} },
    { key: "failed", label: "Update failed", attention: true, onSelect: () => {} },
    { key: "plain", label: "Settings", onSelect: () => {} },
  ]);
  const item = (label: string) => html.split('role="menuitem"').find((chunk) => chunk.includes(`>${label}</span>`)) ?? "";
  expect(item("Restart to update")).toContain("rounded-full bg-accent");
  expect(item("Update failed")).toContain("rounded-full bg-danger");
  expect(item("Settings")).not.toMatch(/rounded-full bg-(accent|danger)/);
  expect(html.split('role="menu"')[0]).not.toMatch(/rounded-full bg-(accent|danger)/);
});

it("marks an on item with a trailing check and no fill of its own, and an off item with neither, both lit only on hover", () => {
  const html = render([
    { key: "quiet", label: "Quiet for an hour", active: true, onSelect: () => {} },
    { key: "settings", label: "Settings", onSelect: () => {} },
  ]);
  const row = (label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*>${label}</span>(?:(?!</button>).)*</button>`))?.[0] ?? "";
  const on = row("Quiet for an hour");
  const off = row("Settings");
  expect(on).toContain('role="menuitemcheckbox"');
  expect(on).toContain('aria-checked="true"');
  expect(on).toContain("data-menu-check");
  expect(on).toMatch(/class="[^"]*hover:bg-menu-row/);
  expect(on).not.toMatch(/class="[^"]*(?<!hover:)bg-menu-row/);
  expect(off).toContain('role="menuitem"');
  expect(off).not.toContain("aria-checked");
  expect(off).not.toContain("data-menu-check");
  expect(off).toMatch(/class="[^"]*hover:bg-menu-row/);
  expect(off).not.toMatch(/class="[^"]*(?<!hover:)bg-menu-row/);
});
