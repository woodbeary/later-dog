import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MCP_CONNECTORS, type McpConnector } from "@/lib/mcp-connectors";

// PluginsPanel's state seeded by call order, as PluginsPanel.navigation.test.ts
// does; the connector cards are stubbed so only the panel's wiring is tested.
const fixture = vi.hoisted(() => ({
  surface: "apps" as "apps" | "mcp",
  dispatch: vi.fn(),
  overrides: new Map<number, unknown>(),
  index: 0,
  counting: false,
  cards: null as null | { connectors: McpConnector[]; refreshKey?: number; onConnected?: (ids: string[]) => void; onServersChange?: () => void },
  embedded: null as null | { refreshKey?: number },
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useEffect: () => {},
    useState: (initial: unknown) => {
      if (!fixture.counting) return react.useState(initial);
      const index = fixture.index++;
      const seeded = fixture.overrides.has(index) ? fixture.overrides.get(index) : typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [seeded, (value: unknown) => {
        const current = fixture.overrides.has(index) ? fixture.overrides.get(index) : seeded;
        fixture.overrides.set(index, typeof value === "function" ? (value as (current: unknown) => unknown)(current) : value);
      }];
    },
  };
});
vi.mock("@/state/store", () => ({
  api: vi.fn(() => new Promise(() => {})),
  useStore: () => ({ state: { pluginsSurface: fixture.surface, bots: [], instances: [] }, dispatch: fixture.dispatch }),
}));
vi.mock("./McpServersPanel", () => ({
  McpServersPanel: (props: { embedded?: boolean; whopCard?: boolean; refreshKey?: number }) => {
    if (props.whopCard) return createElement("div", { "data-whop-card": true }, "Connect Whop");
    fixture.embedded = props;
    return createElement("div", { "data-embedded": "true" }, "MCP inventory");
  },
}));
vi.mock("./McpConnectorCards", () => ({
  McpConnectorCards: (props: NonNullable<typeof fixture.cards>) => {
    fixture.cards = props;
    return createElement("div", { "data-connectors": props.connectors.map((connector) => connector.id).join(",") });
  },
}));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
import { PluginsPanel } from "./PluginsPanel";

// state slots, in the order PluginsPanel declares them
const CARDS = 0;
const CONFIGURED = 3;
const SETUP = 5;
const STATUS = 6;
const PHASE = 13;
const SEARCH = 15;
const TAB = 16;
const WHOP_CONNECTED = 18;
const REFRESH = 19;
const CONNECTED_CONNECTORS = 20;

type Node = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree!: ReturnType<typeof PluginsPanel>;
  function Capture() {
    fixture.index = 0;
    fixture.counting = true;
    try { tree = PluginsPanel(); } finally { fixture.counting = false; }
    return tree;
  }
  fixture.cards = null;
  fixture.embedded = null;
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const shown = () => fixture.cards?.connectors.map((connector) => connector.id) ?? null;
const card = (slug: string) => ({ slug, label: slug[0]!.toUpperCase() + slug.slice(1), blurb: `${slug} things`, logo: null, domain: null });

beforeEach(() => {
  vi.stubGlobal("window", {});
  fixture.surface = "apps";
  fixture.dispatch.mockReset();
  fixture.overrides = new Map<number, unknown>([
    [CARDS, [card("gmail"), card("slack")]],
    [CONFIGURED, false],
    [STATUS, { slack: { connected: true, accounts: [{ id: "ca_1", status: "ACTIVE" }] } }],
    [PHASE, "ready"],
  ]);
});
afterEach(() => vi.unstubAllGlobals());

describe("setting up connected apps", () => {
  beforeEach(() => fixture.overrides.set(SETUP, "needs-setup"));

  it("takes the Composio key right in the notice, with no Settings page to visit", () => {
    const { html } = render();
    expect(html).toContain("Paste a Composio project key below");
    expect(html).toContain('data-api-key-row="composio"');
    expect(html).not.toContain("Settings →");
  });

  it("drops the notice and its key box once the key is in", () => {
    fixture.overrides.set(CONFIGURED, true);
    const { html } = render();
    expect(html).not.toContain("data-connectors-key");
    expect(html).not.toContain('data-api-key-row="composio"');
  });
});

describe("connectors in the Apps pop-up", () => {
  it("lead the apps section as rows of their own, every one of them, with no Composio key", () => {
    const { html, nodes: tree } = render();
    expect(shown()).toEqual(MCP_CONNECTORS.map((connector) => connector.id));
    const section = tree.find((node) => node.props["data-apps-grid"] !== undefined)!;
    const inSection = nodes(section);
    const cards = inSection.findIndex((node) => Array.isArray(node.props.connectors));
    const whop = inSection.findIndex((node) => node.props.whopCard === true);
    expect(cards).toBeGreaterThanOrEqual(0);
    expect(whop).toBeGreaterThan(cards);
    // not cells of the apps' card grid: their rows sit on the pop-up itself
    const grid = inSection.find((node) => String(node.props.className ?? "").includes("@3xl:grid-cols-3"))!;
    expect(nodes(grid).some((node) => Array.isArray(node.props.connectors))).toBe(false);
    expect(html.indexOf("data-connectors")).toBeLessThan(html.indexOf("data-whop-card"));
    expect(html.indexOf("data-whop-card")).toBeLessThan(html.indexOf('data-app-tile="gmail"'));
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("narrow with the search box", () => {
    fixture.overrides.set(SEARCH, "pay");
    render();
    expect(shown()).toEqual(["paypal", "stripe"]);
    fixture.overrides.set(SEARCH, "gmail");
    const { html } = render();
    expect(shown()).toEqual([]);
    expect(html).toContain('data-app-tile="gmail"');
  });

  it("show only the connected ones under Connected, and count them", () => {
    fixture.overrides.set(TAB, "connected");
    fixture.overrides.set(CONNECTED_CONNECTORS, ["linear"]);
    const { html } = render();
    expect(shown()).toEqual(["linear"]);
    expect(html).toContain("Connected 2");
  });

  it("never sit under a claim that nothing is connected", () => {
    fixture.overrides.set(TAB, "connected");
    fixture.overrides.set(STATUS, {});
    fixture.overrides.set(WHOP_CONNECTED, false);
    fixture.overrides.set(CONNECTED_CONNECTORS, ["linear"]);
    let { html } = render();
    expect(html).not.toContain("No connected apps yet");
    fixture.overrides.set(CONNECTED_CONNECTORS, []);
    ({ html } = render());
    expect(html).toContain("No connected apps yet");
  });

  it("stay out of the MCP servers view", () => {
    fixture.surface = "mcp";
    const { html } = render();
    expect(fixture.cards).toBeNull();
    expect(html).toContain("MCP inventory");
  });

  it("report their connections to the panel, and refresh the server lists after a change", () => {
    render();
    fixture.cards!.onConnected!(["notion", "stripe"]);
    expect(fixture.overrides.get(CONNECTED_CONNECTORS)).toEqual(["notion", "stripe"]);
    expect(fixture.cards!.refreshKey).toBe(0);
    expect(fixture.embedded!.refreshKey).toBe(0);
    fixture.cards!.onServersChange!();
    expect(fixture.overrides.get(REFRESH)).toBe(1);
    render();
    expect(fixture.cards!.refreshKey).toBe(1);
    expect(fixture.embedded!.refreshKey).toBe(1);
  });
});
