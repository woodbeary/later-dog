import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIDEBAR_ROW_KINDS, sidebarRowKind } from "./sidebar-row-kind";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../components/Sidebar.tsx", import.meta.url), "utf8");
const heldHeight = (kind: string) => Number(new RegExp(`\\[data-sidebar-row="${kind}"\\] \\{ contain-intrinsic-size: auto ([\\d.]+)px; \\}`).exec(css)?.[1]);

const ROW = { padding: 8, nameText: 14, previewText: 11, titleLine: 16, lineHeight: 1.5, iconPadding: 6, iconAvatar: 44 };

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

  it("holds the height of a drawn row of its kind while the row is scrolled out of view", () => {
    const plain = 2 * ROW.padding + ROW.lineHeight * (ROW.nameText + ROW.previewText);
    expect(Object.fromEntries(SIDEBAR_ROW_KINDS.map((kind) => [kind, heldHeight(kind)]))).toEqual({
      plain,
      titled: plain + ROW.titleLine,
      icon: 2 * ROW.iconPadding + ROW.iconAvatar,
    });
  });

  it("skips drawing every kind of row that is out of view", () => {
    expect(css).toMatch(/\[data-sidebar-row\] \{\n {2}content-visibility: auto;/);
  });
});
