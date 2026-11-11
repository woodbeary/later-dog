import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIDEBAR_ROW_KINDS, sidebarRowKind } from "./sidebar-row-kind";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../components/Sidebar.tsx", import.meta.url), "utf8");
const heldHeight = (kind: string) => Number(new RegExp(`\\[data-sidebar-row="${kind}"\\] > \\[data-sidebar-bot-row\\] \\{ contain-intrinsic-size: auto ([\\d.]+)px; \\}`).exec(css)?.[1]);

const ROW = { nameText: 14, previewText: 11, titleLine: 16, lineHeight: 1.5, iconAvatar: 44 };

describe("the kind of row a dog gets in the sidebar", () => {
  it("is the icon row in the icon rail, whatever the dog's title", () => {
    expect(sidebarRowKind({ iconOnly: true, titled: true })).toBe("icon");
    expect(sidebarRowKind({ iconOnly: true, titled: false })).toBe("icon");
  });

  it("is taller when the dog shows a title above its name", () => {
    expect(sidebarRowKind({ iconOnly: false, titled: true })).toBe("titled");
    expect(sidebarRowKind({ iconOnly: false, titled: false })).toBe("plain");
  });

  it("lays a dog's row out with the paddings, text sizes and avatar the held heights are worked out from", () => {
    expect(sidebar).toContain('? "justify-center px-1 py-1.5"');
    expect(sidebar).toContain(': "gap-3 py-2 pl-2 pr-9"');
    expect(sidebar).toContain("const avatarSize = iconOnly ? 44 : 32;");
    expect(sidebar).toContain('<div className="truncate text-[11px] font-medium leading-4 text-ink-secondary">{title}</div>');
    expect(sidebar).toContain('<span className="flex min-w-0 grow items-center gap-1.5 truncate text-[14px] font-semibold text-ink">');
    expect(sidebar).toContain('<span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-ink-secondary">');
  });

  it("holds the height of what a drawn row of its kind shows inside its padding while the row is scrolled out of view", () => {
    const plain = ROW.lineHeight * (ROW.nameText + ROW.previewText);
    expect(Object.fromEntries(SIDEBAR_ROW_KINDS.map((kind) => [kind, heldHeight(kind)]))).toEqual({
      plain,
      titled: plain + ROW.titleLine,
      icon: ROW.iconAvatar,
    });
  });

  it("skips drawing what is inside a row that is out of view, and keeps the row itself for a screen reader to find", () => {
    expect(css).toMatch(/\[data-sidebar-row\] > \[data-sidebar-bot-row\] \{\n {2}content-visibility: auto;/);
    expect(css).not.toMatch(/\[data-sidebar-row[^\]]*\] \{[^}]*content-visibility/);
  });
});
