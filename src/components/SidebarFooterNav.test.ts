// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: [], groups: [] }, dispatch: vi.fn() }) }));
import { SidebarBugButton, SidebarFooterNav } from "./SidebarFooterNav";
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });
it.each(["comfortable"] as const)("leaves the full-width footer row to its existing profile and bug controls (%s)", (density) => {
  expect(renderToStaticMarkup(createElement(SidebarFooterNav, { density }))).toBe("");
});
describe("bug report access", () => {
  it("replaces Apps in the narrow rail", () => {
    const html = renderToStaticMarkup(createElement(SidebarFooterNav, { density: "icons" }));
    expect(html).toContain('data-sidebar-nav="bug-report"');
    expect(html).toContain('aria-label="Report a bug"');
    expect(html).not.toContain('data-tour="nav-apps"');
  });
  it("opens the report dialog in place without sending anything", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(SidebarBugButton)));
    await act(async () => host.querySelector("button")!.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("What happened?");
    expect(dialog?.textContent).toContain("You finish submitting on GitHub.");
    expect(dialog?.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(true);
    expect(dialog?.textContent).not.toContain("Save diagnostics");
    await act(async () => root.unmount());
  });
});
