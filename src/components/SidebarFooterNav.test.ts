import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: {} as Record<string, unknown>,
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
import { SidebarAppsButton, SidebarFooterNav } from "./SidebarFooterNav";

function render(density: SidebarDensity) {
  let tree!: ReturnType<typeof SidebarFooterNav>;
  function Capture() { tree = SidebarFooterNav({ density }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, tree };
}

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.state = { activeView: "chat", routineRuns: [], triggersOpen: false, pluginsOpen: false };
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("sidebar footer places", () => {
  it.each(["comfortable", "compact"] as const)("draws nothing on a full-width sidebar: the builder rows left with Advanced mode (%s)", (density) => {
    const { html } = render(density);
    expect(html).toBe("");
    for (const gone of ["workspace", "routines", "triggers", "team-map"]) expect(html).not.toContain(`data-sidebar-nav="${gone}"`);
  });

  it("keeps Apps on the avatars-only rail, as an icon with a tooltip, under the tour's Apps anchor", () => {
    const { html, tree } = render("icons");
    expect(html).not.toContain('data-tour="tools"');
    expect(html).toMatch(/data-tour="nav-apps" data-sidebar-nav="apps"/);
    expect(html).toContain('aria-label="Apps" title="Apps"');
    expect(html).not.toContain(">Apps</span>");
    expect(html).not.toContain('data-sidebar-nav="routines"');
    expect(html).not.toContain('data-sidebar-nav="triggers"');
    const row = (tree as { props: { children: { props: { onClick: () => void } } } }).props.children;
    row.props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true });
  });
});

describe("Apps beside the profile", () => {
  it("is one icon button that opens Apps and carries the tour's Apps anchor", () => {
    let tree!: ReturnType<typeof SidebarAppsButton>;
    function Capture() { tree = SidebarAppsButton(); return tree; }
    const html = renderToStaticMarkup(createElement(Capture));
    expect(html).toMatch(/data-tour="nav-apps" data-sidebar-nav="apps"/);
    expect(html).toContain('aria-label="Apps"');
    (tree.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true });
  });
});
