import { Children, createElement, isValidElement, type DependencyList, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BRAND_MARKS } from "@/lib/brand-icons";
import { MCP_CONNECTORS, type McpConnector, type McpServerRow } from "@/lib/mcp-connectors";

// Hook state by call order, kept between renders, the way the neighbouring
// panel tests seed it: effects never run under server rendering.
const fixture = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
  effects: [] as Array<{ effect: EffectCallback; deps?: DependencyList }>,
  bots: [] as unknown[],
  config: null as unknown,
  routes: {} as Record<string, (body: unknown) => unknown>,
  calls: [] as Array<{ path: string; method: string; body?: unknown }>,
  dispatch: vi.fn(),
  open: vi.fn(async (_url: string) => {}),
  updateMcpServers: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? (next as (current: unknown) => unknown)(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    return fixture.values[index] ??= { current: initial };
  },
  useEffect: (effect: EffectCallback, deps?: DependencyList) => { fixture.effects.push({ effect, deps }); },
}));
vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    fixture.calls.push({ path, method, ...(body === undefined ? {} : { body }) });
    const route = fixture.routes[`${method} ${path}`];
    if (!route) throw new Error(`unexpected ${method} ${path}`);
    return route(body);
  }),
  useStore: () => ({ state: { bots: fixture.bots, config: fixture.config }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/mcp-servers", () => ({
  updateMcpServers: fixture.updateMcpServers,
  useMcpServers: () => ({ servers: null, error: false, refresh: vi.fn() }),
}));
vi.mock("@/lib/app-links", () => ({ openExternalLink: fixture.open }));
import { AddServerToBots } from "./AddServerToBots";
import { McpConnectorCards } from "./McpConnectorCards";

// state slots, in the order McpConnectorCards declares them
const SERVERS = 0;
const ERRORS = 3;

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
const textOf = (node: Node): string => Children.toArray(node.props.children)
  .map((child) => typeof child === "string" ? child : isValidElement(child) ? textOf(child as Node) : "")
  .join("");
const byId = (id: string) => MCP_CONNECTORS.find((connector) => connector.id === id)!;
const props = {
  connectors: [] as McpConnector[],
  onConnected: vi.fn(),
  onServersChange: vi.fn(),
};
function render() {
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    fixture.effects = [];
    tree = McpConnectorCards(props);
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const tile = (id: string) => {
    const found = all.find((node) => node.props["data-connector-tile"] === id);
    if (!found) throw new Error(`no ${id} card`);
    const inside = nodes(found.props.children);
    return {
      html: renderToStaticMarkup(found),
      button: (label: string) => inside.find((node) => node.type === "button" && (node.props["aria-label"] === label || textOf(node) === label)),
      inside,
    };
  };
  return { html, all, tile };
}
const click = (node: Node | undefined) => {
  if (!node) throw new Error("no such control");
  (node.props.onClick as () => void)();
};
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const row = (extra: Partial<McpServerRow> & { name: string }): McpServerRow => ({ type: "http", headerKeys: [], enabled: false, ...extra });

const WAITING = { phase: "waiting", flowId: "flow-1", authorizationUrl: "https://mcp.sentry.dev/oauth/authorize?client_id=x", expiresAt: "2026-10-08T00:05:00Z" };

beforeEach(() => {
  vi.useFakeTimers();
  fixture.values = [];
  fixture.effects = [];
  fixture.bots = [];
  fixture.config = null;
  fixture.routes = {};
  fixture.calls = [];
  fixture.dispatch.mockReset();
  fixture.open.mockReset();
  fixture.updateMcpServers.mockReset();
  props.connectors = [];
  props.onConnected = vi.fn();
  props.onServersChange = vi.fn();
});
afterEach(() => vi.useRealTimers());

describe("connector rows", () => {
  it("shows each row's brand mark, name, description, limitations and docs link, with no fetched images", () => {
    props.connectors = [byId("linear"), byId("webflow"), byId("intercom")];
    fixture.values[SERVERS] = [];
    const { html, tile } = render();
    expect(html).not.toContain("<img");
    // rows of their own on the pop-up's surface, two columns when there is room
    expect(html).toContain('data-connector-list="true" class="mb-4 grid grid-cols-1 gap-x-8 @3xl:grid-cols-2"');
    expect(html).not.toContain("glass-card");
    const linear = tile("linear");
    expect(linear.html).toContain(">Linear<");
    expect(linear.html).toContain("Find, create and update Linear issues, projects and comments.");
    // the bundled mark, silent beside the name it would repeat
    expect(linear.html).toContain('data-brand-icon="linear" aria-hidden="true"');
    expect(linear.html).toContain(`<path d="${BRAND_MARKS.linear.path}"></path>`);
    expect(linear.html).not.toContain('role="img"');
    expect(linear.html).toContain('href="https://linear.app/docs/mcp" target="_blank" rel="noopener noreferrer" aria-label="Linear MCP docs"');
    expect(linear.html).not.toContain("SSE");
    // limitations stay visible on the row: the older transport, the provider's own
    expect(tile("webflow").html).toContain("Uses the older SSE connection, which Codex dogs skip.");
    expect(tile("intercom").html).toContain("For Intercom accounts hosted in the US.");
    expect(linear.html).not.toContain("hosted in the US");
  });

  it("reads Connected, Needs sign-in, Error and Managed from the servers as configured", () => {
    props.connectors = [byId("sentry"), byId("linear"), byId("notion"), byId("stripe")];
    fixture.values[SERVERS] = [
      row({ name: "tracker", url: "https://mcp.linear.app/mcp", enabled: true, auth: "signed-in" }),
      row({ name: "notion", url: "https://mcp.notion.com/mcp", enabled: true, auth: "needs-sign-in" }),
      row({ name: "stripe", url: "https://mcp.stripe.com/", managedBy: "Acme" }),
    ];
    fixture.values[ERRORS] = { sentry: "Sign-in was not approved." };
    const { html, tile } = render();

    // added by hand under another name: already connected, and leading the grid
    const linear = tile("linear");
    expect(linear.html).toContain("Connected");
    expect(linear.button("Disconnect Linear")).toBeDefined();
    expect(html.indexOf('data-connector-tile="linear"')).toBeLessThan(html.indexOf('data-connector-tile="sentry"'));

    const notion = tile("notion");
    expect(notion.html).toContain("Needs sign-in");
    expect(notion.button("Sign in to Notion")?.props.children).toBe("Sign in");

    const sentry = tile("sentry");
    expect(sentry.html).toContain('role="alert"');
    expect(sentry.html).toContain("Sign-in was not approved.");
    expect(sentry.button("Connect Sentry")?.props.children).toBe("Retry");
    expect(sentry.html).not.toContain("Connected");

    const stripe = tile("stripe");
    expect(stripe.html).toContain("Managed by Acme");
    expect(stripe.button("Connect Stripe")?.props.disabled).toBe(true);
  });

  it("waits for the server list before offering Connect", () => {
    props.connectors = [byId("linear")];
    const { tile } = render();
    const button = tile("linear").button("Checking…");
    expect(button?.props.disabled).toBe(true);
    expect(button?.props["aria-label"]).toBeUndefined();
  });

  it("reports which catalog connectors are connected, even while a search hides every row", () => {
    props.connectors = [];
    fixture.values[SERVERS] = [
      row({ name: "linear", url: "https://mcp.linear.app/mcp", enabled: true, auth: "signed-in" }),
      row({ name: "neon", url: "https://mcp.neon.tech/mcp", enabled: true, headerKeys: ["Authorization"] }),
      row({ name: "notion", url: "https://mcp.notion.com/mcp", enabled: false, auth: "signed-in" }),
    ];
    expect(render().html).toBe("");
    const report = fixture.effects.find(({ deps }) => deps?.[1] === props.onConnected)!;
    report.effect();
    expect(props.onConnected).toHaveBeenCalledWith(["linear", "neon"]);
  });

  it("offers to add a connected connector to each dog whose own server list leaves it out", () => {
    props.connectors = [byId("linear")];
    fixture.values[SERVERS] = [row({ name: "tracker", url: "https://mcp.linear.app/mcp", enabled: true, auth: "signed-in" })];
    fixture.bots = [
      { id: "rex", name: "Rex", mcpServers: ["notion"] },
      { id: "scout", name: "Scout", mcpServers: null },
      { id: "pip", name: "Pip", mcpServers: ["tracker"] },
      { id: "ghost", name: "Ghost", hidden: true, mcpServers: [] },
    ];
    const linear = render().tile("linear");
    expect(linear.html).toContain("Dogs that pick their own servers need it added: 1");
    expect(linear.html).toContain("Add to Rex");
    for (const name of ["Scout", "Pip", "Ghost"]) expect(linear.html).not.toContain(`Add to ${name}`);
    expect(linear.inside.find((node) => node.type === AddServerToBots)?.props.server).toBe("tracker");
  });
});

describe("Connect", () => {
  it("adds the server through the MCP server API, starts the sign-in, and turns it on once signed in and tested", async () => {
    const sentry = byId("sentry");
    props.connectors = [sentry];
    fixture.values[SERVERS] = [];
    const added = row({ name: "sentry", url: sentry.url });
    const connected = { ...added, enabled: true, auth: "signed-in" as const };
    fixture.routes = {
      "POST /api/mcp/servers": () => ({ servers: [added] }),
      "POST /api/mcp/servers/sentry/sign-in": () => ({ auth: WAITING }),
      "POST /api/mcp/servers/sentry/sign-in/flow-1": () => ({ auth: { ...WAITING, phase: "succeeded", authorizationUrl: null } }),
      "POST /api/mcp/servers/sentry/test": () => ({ ok: true, tools: [{ name: "find_issues" }] }),
      "PATCH /api/mcp/servers/sentry": () => ({ servers: [connected] }),
      "GET /api/mcp/servers": () => ({ servers: [connected] }),
    };

    click(render().tile("sentry").button("Connect Sentry"));
    await flush();
    expect(fixture.calls).toEqual([
      { path: "/api/mcp/servers", method: "POST", body: { name: "sentry", type: "http", url: "https://mcp.sentry.dev/mcp", enabled: false } },
      { path: "/api/mcp/servers/sentry/sign-in", method: "POST" },
    ]);
    expect(fixture.open).toHaveBeenCalledWith(WAITING.authorizationUrl);

    // waiting on the browser: Cancel, reopen, and paste-back from another computer
    let card = render().tile("sentry");
    expect(card.html).toContain("Finish signing in in your browser…");
    expect(card.button("Cancel signing in to Sentry")).toBeDefined();
    expect(card.html).toContain("Open sign-in page");
    const field = card.inside.find((node) => node.props.id === "connector-callback-sentry")!;
    (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "http://127.0.0.1:20123/mcp-oauth/callback?code=c&state=s" } });
    card = render().tile("sentry");
    click(card.button("Complete sign-in"));
    await flush();

    expect(fixture.calls.slice(2)).toEqual([
      { path: "/api/mcp/servers/sentry/sign-in/flow-1", method: "POST", body: { callbackUrl: "http://127.0.0.1:20123/mcp-oauth/callback?code=c&state=s" } },
      { path: "/api/mcp/servers/sentry/test", method: "POST" },
      { path: "/api/mcp/servers/sentry", method: "PATCH", body: { enabled: true } },
      { path: "/api/mcp/servers", method: "GET" },
    ]);
    expect(fixture.updateMcpServers).toHaveBeenLastCalledWith([connected]);
    expect(props.onServersChange).toHaveBeenCalled();
    card = render().tile("sentry");
    expect(card.html).toContain("Connected");
    expect(card.button("Disconnect Sentry")).toBeDefined();
  });

  it("cancels the sign-in without testing or switching the server on", async () => {
    props.connectors = [byId("sentry")];
    const existing = row({ name: "sentry", url: "https://mcp.sentry.dev/mcp" });
    fixture.values[SERVERS] = [existing];
    fixture.routes = {
      "POST /api/mcp/servers/sentry/sign-in": () => ({ auth: WAITING }),
      "DELETE /api/mcp/servers/sentry/sign-in/flow-1": () => ({ ok: true }),
      "GET /api/mcp/servers": () => ({ servers: [existing] }),
    };
    click(render().tile("sentry").button("Connect Sentry"));
    await flush();
    click(render().tile("sentry").button("Cancel signing in to Sentry"));
    await flush();
    expect(fixture.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/mcp/servers/sentry/sign-in",
      "DELETE /api/mcp/servers/sentry/sign-in/flow-1",
      "GET /api/mcp/servers",
    ]);
    const card = render().tile("sentry");
    expect(card.button("Connect Sentry")?.props.children).toBe("Connect");
    expect(card.html).not.toContain('role="alert"');
  });

  it("shows the failure on the card and leaves the server off when its tools do not load", async () => {
    props.connectors = [byId("linear")];
    const existing = row({ name: "linear", url: "https://mcp.linear.app/mcp", auth: "signed-in" });
    fixture.values[SERVERS] = [existing];
    fixture.routes = {
      "POST /api/mcp/servers/linear/test": () => ({ ok: false, error: "The server did not answer in time." }),
      "GET /api/mcp/servers": () => ({ servers: [existing] }),
    };
    click(render().tile("linear").button("Connect Linear"));
    await flush();
    expect(fixture.calls.some((call) => call.method === "PATCH")).toBe(false);
    const card = render().tile("linear");
    expect(card.html).toContain("Signed in, but Linear’s tools could not be loaded. Connect again to retry.");
    expect(card.button("Connect Linear")?.props.children).toBe("Retry");
  });

  it("shows an error the API answers with, such as an organization refusal", async () => {
    props.connectors = [byId("linear")];
    fixture.values[SERVERS] = [];
    fixture.routes = {
      "POST /api/mcp/servers": () => { throw new Error("Your organization has not approved this MCP server."); },
      "GET /api/mcp/servers": () => ({ servers: [] }),
    };
    click(render().tile("linear").button("Connect Linear"));
    await flush();
    expect(render().tile("linear").html).toContain("Your organization has not approved this MCP server.");
  });

  it("disconnects by switching the server off and signing out", async () => {
    props.connectors = [byId("linear")];
    const connected = row({ name: "tracker", url: "https://mcp.linear.app/mcp", enabled: true, auth: "signed-in" });
    fixture.values[SERVERS] = [connected];
    fixture.routes = {
      "PATCH /api/mcp/servers/tracker": () => ({ servers: [{ ...connected, enabled: false }] }),
      "POST /api/mcp/servers/tracker/sign-out": () => ({ servers: [{ ...connected, enabled: false, auth: undefined }] }),
      "GET /api/mcp/servers": () => ({ servers: [{ ...connected, enabled: false, auth: undefined }] }),
    };
    click(render().tile("linear").button("Disconnect Linear"));
    await flush();
    expect(fixture.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PATCH /api/mcp/servers/tracker",
      "POST /api/mcp/servers/tracker/sign-out",
      "GET /api/mcp/servers",
    ]);
    expect(fixture.calls[0]!.body).toEqual({ enabled: false });
    expect(render().tile("linear").button("Connect Linear")).toBeDefined();
  });

  it("keeps Connect off while the organization allows no MCP servers", () => {
    props.connectors = [byId("linear")];
    fixture.values[SERVERS] = [];
    fixture.config = { managedPolicy: { organizationName: "Acme", mcp: { allowCustom: false, allowlist: [] } } };
    const button = render().tile("linear").button("Connect Linear");
    expect(button?.props.disabled).toBe(true);
    expect(button?.props.title).toBe("Managed by Acme");
  });
});
