import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: [], groups: [] }, dispatch }) }));
import { ConnectAppsPill, SidebarFooterNav } from "./SidebarFooterNav";

describe("footer, like Grok Bot's", () => {
  it("shows a Connect apps pill that opens the apps panel", () => {
    const html = renderToStaticMarkup(createElement(ConnectAppsPill));
    expect(html).toContain('data-sidebar-nav="connect-apps"');
    expect(html).toContain(">Connect apps<");
    expect(html).not.toContain("Report a bug");
  });

  it("leaves the full-width footer to the avatar, the pill and the update icon", () => {
    expect(renderToStaticMarkup(createElement(SidebarFooterNav, { density: "comfortable" }))).toBe("");
  });

  it("keeps Connect apps on the narrow rail as an icon", () => {
    const html = renderToStaticMarkup(createElement(SidebarFooterNav, { density: "icons" }));
    expect(html).toContain('data-sidebar-nav="connect-apps"');
    expect(html).toContain('aria-label="Connect apps"');
    expect(html).not.toContain('data-sidebar-nav="bug-report"');
  });
});
