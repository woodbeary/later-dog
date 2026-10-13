import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MCP_CONNECTOR_CATEGORIES, MCP_CONNECTORS, type McpConnector, type McpConnectorCategory } from "@/lib/mcp-connectors";

const fixture = vi.hoisted(() => ({
  surface: "apps" as "apps" | "mcp",
  dispatch: vi.fn(),
  overrides: new Map<number, unknown>(),
  index: 0,
  counting: false,
  cards: null as null | {
    connectors: McpConnector[];
    refreshKey?: number;
    grouped?: { limit: number; onViewAll: (category: McpConnectorCategory) => void };
    onConnected?: (ids: string[]) => void;
    onServersChange?: () => void;
  },
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
const CATEGORY = 21;
const MORE = 22;

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
const inCategory = (category: McpConnectorCategory) => MCP_CONNECTORS.filter((connector) => connector.category === category).map((connector) => connector.id);
const control = (tree: Node[], attribute: string, value: string) => {
  const found = tree.find((node) => node.props[attribute] === value);
  if (!found) throw new Error(`no ${attribute}=${value}`);
  return found;
};
const press = (node: Node) => (node.props.onClick as () => void)();
const whopWrapper = (tree: Node[]) => tree.find((node) => isValidElement(node.props.children) && (node.props.children as Node).props.whopCard === true)!;
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

  it("asks for the Composio key in one line, behind Add key, instead of showing apps that can't connect", () => {
    const { html } = render();
    expect(html).toContain("Gmail, Slack and many more connect through Composio. Add a Composio key to use them.");
    expect(html).toContain(">Add key</button>");
    expect(html).not.toContain('data-api-key-row="composio"');
    expect(html).not.toContain("Settings →");
    const notice = html.indexOf("data-connectors-key");
    expect(notice).toBeGreaterThan(html.indexOf("data-apps-grid"));
    expect(notice).toBeGreaterThan(html.indexOf("data-connectors="));
    expect(notice).toBeLessThan(html.indexOf("data-whop-card"));
    expect(html).not.toContain('data-app-tile="gmail"');
  });

  it("only explains it on a remote screen, where no key can be typed", () => {
    vi.stubGlobal("window", { laterdog: { remoteClient: { active: true } } });
    const { html } = render();
    expect(html).toContain("Ask whoever runs this server to paste a Composio project key into Apps on that computer.");
    expect(html).not.toContain(">Add key</button>");
  });

  it("names the key when a search finds an app that needs it", () => {
    fixture.overrides.set(SEARCH, "gmail");
    expect(render().html).toContain("data-connectors-key");
  });

  it("stays away when nothing listed needs the key", () => {
    fixture.overrides.set(SEARCH, "linear");
    expect(render().html).not.toContain("data-connectors-key");
    fixture.overrides.set(SEARCH, "");
    fixture.overrides.set(TAB, "connected");
    expect(render().html).not.toContain("data-connectors-key");
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
    fixture.overrides.set(CONFIGURED, true);
    const { html, nodes: tree } = render();
    expect(shown()).toEqual(MCP_CONNECTORS.map((connector) => connector.id));
    expect(fixture.cards!.grouped?.limit).toBe(4);
    const section = tree.find((node) => node.props["data-apps-grid"] !== undefined)!;
    const inSection = nodes(section);
    const cards = inSection.findIndex((node) => Array.isArray(node.props.connectors));
    const whop = inSection.findIndex((node) => node.props.whopCard === true);
    expect(cards).toBeGreaterThanOrEqual(0);
    expect(whop).toBeGreaterThan(cards);
    const grid = inSection.find((node) => String(node.props.className ?? "").includes("@3xl:grid-cols-3"))!;
    expect(nodes(grid).some((node) => Array.isArray(node.props.connectors))).toBe(false);
    expect(html.indexOf("data-connectors")).toBeLessThan(html.indexOf("data-whop-card"));
    expect(html.indexOf("data-whop-card")).toBeLessThan(html.indexOf('data-app-tile="gmail"'));
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("narrow with the search box", () => {
    fixture.overrides.set(SEARCH, "pay");
    render();
    expect(shown()).toEqual(["paypal", "stripe", "square", "revenuecat", "airwallex"]);
    expect(fixture.cards!.grouped).toBeUndefined();
    fixture.overrides.set(SEARCH, "gmail");
    let { html } = render();
    expect(shown()).toEqual([]);
    expect(html).not.toContain('data-app-tile="gmail"');
    fixture.overrides.set(CONFIGURED, true);
    ({ html } = render());
    expect(html).toContain('data-app-tile="gmail"');
  });

  it("browse one category at a time from the chips, the More menu or a section's View all", () => {
    fixture.overrides.set(CONFIGURED, true);
    let { html, nodes: tree } = render();
    expect(tree.filter((node) => node.props["data-apps-filter"] !== undefined).map((node) => node.props["data-apps-filter"]))
      .toEqual(["all", "connected", "projects", "email", "design", "code", "more", "mcp"]);
    expect(control(tree, "data-apps-filter", "all").props["aria-pressed"]).toBe(true);
    expect(html).toContain("data-apps-more-heading");

    press(control(tree, "data-apps-filter", "design"));
    expect(fixture.overrides.get(CATEGORY)).toBe("design");
    ({ html, nodes: tree } = render());
    expect(shown()).toEqual(inCategory("design"));
    expect(fixture.cards!.grouped).toBeUndefined();
    expect(control(tree, "data-apps-filter", "design").props["aria-pressed"]).toBe(true);
    expect(control(tree, "data-apps-filter", "all").props["aria-pressed"]).toBe(false);
    expect(html).toContain('id="apps-grid-title" class="mb-3 text-[12px] font-medium text-ink-secondary">Design and media</div>');
    expect(html).not.toContain("data-app-tile");
    expect(html).not.toContain("data-apps-more-heading");
    expect(whopWrapper(tree).props.className).toBe("hidden");

    const more = control(tree, "data-apps-filter", "more");
    expect(more.props["aria-haspopup"]).toBe("menu");
    expect(more.props["aria-expanded"]).toBe(false);
    expect(tree.some((node) => node.props.role === "menu")).toBe(false);
    press(more);
    expect(fixture.overrides.get(MORE)).toBe(true);
    ({ nodes: tree } = render());
    const items = tree.filter((node) => node.props.role === "menuitemradio");
    expect(items.map((node) => node.props["data-apps-category"]))
      .toEqual(Object.keys(MCP_CONNECTOR_CATEGORIES).filter((key) => !["projects", "email", "design", "code"].includes(key)));
    expect(items.every((node) => node.props["aria-checked"] === false)).toBe(true);
    press(control(tree, "data-apps-category", "payments"));
    expect(fixture.overrides.get(CATEGORY)).toBe("payments");
    expect(fixture.overrides.get(MORE)).toBe(false);
    ({ html, nodes: tree } = render());
    expect(shown()).toEqual(["paypal", "stripe", "square", "revenuecat"]);
    expect(whopWrapper(tree).props.className).toBe("contents");
    expect(renderToStaticMarkup(control(tree, "data-apps-filter", "more"))).toContain(">Payments<");

    fixture.overrides.set(SEARCH, "linear");
    ({ html } = render());
    expect(shown()).toEqual([]);
    expect(html).toContain("No apps found");
    fixture.overrides.set(SEARCH, "");

    press(control(render().nodes, "data-apps-filter", "all"));
    expect(fixture.overrides.get(CATEGORY)).toBeNull();
    render();
    fixture.cards!.grouped!.onViewAll("finance");
    expect(fixture.overrides.get(CATEGORY)).toBe("finance");
    render();
    expect(shown()).toEqual(inCategory("finance"));
    press(control(render().nodes, "data-apps-filter", "connected"));
    expect(fixture.overrides.get(CATEGORY)).toBeNull();
    expect(fixture.overrides.get(TAB)).toBe("connected");
  });

  it("close the More menu on Escape without closing Apps", () => {
    fixture.overrides.set(MORE, true);
    const { nodes: tree } = render();
    const wrapper = tree.find((node) => typeof node.props.onKeyDown === "function")!;
    const stopPropagation = vi.fn();
    (wrapper.props.onKeyDown as (event: { key: string; stopPropagation: () => void }) => void)({ key: "Escape", stopPropagation });
    expect(stopPropagation).toHaveBeenCalled();
    expect(fixture.overrides.get(MORE)).toBe(false);
    expect(fixture.dispatch).not.toHaveBeenCalled();
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
    expect(fixture.embedded).toBeNull();
    fixture.cards!.onConnected!(["notion", "stripe"]);
    expect(fixture.overrides.get(CONNECTED_CONNECTORS)).toEqual(["notion", "stripe"]);
    expect(fixture.cards!.refreshKey).toBe(0);
    fixture.cards!.onServersChange!();
    expect(fixture.overrides.get(REFRESH)).toBe(1);
    render();
    expect(fixture.cards!.refreshKey).toBe(1);
    fixture.surface = "mcp";
    render();
    expect(fixture.embedded!.refreshKey).toBe(1);
  });

  it("hide Composio's copy of an app that has its own connector, unless it's connected there", () => {
    fixture.overrides.set(CONFIGURED, true);
    fixture.overrides.set(CARDS, [card("gmail"), card("notion")]);
    let { html } = render();
    expect(html).toContain('data-app-tile="gmail"');
    expect(html).not.toContain('data-app-tile="notion"');
    fixture.overrides.set(STATUS, { notion: { connected: true, accounts: [{ id: "ca_2", status: "ACTIVE" }] } });
    ({ html } = render());
    expect(html).toContain('data-app-tile="notion"');
  });
});
