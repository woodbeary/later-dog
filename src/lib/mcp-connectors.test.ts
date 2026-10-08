import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { en } from "@/locales";
import {
  MCP_CONNECTOR_CATEGORIES,
  MCP_CONNECTORS,
  MCP_CONNECTORS_CHECKED_ON,
  connectMcpConnector,
  connectorMatchesSearch,
  connectorServer,
  connectorServerName,
  connectorState,
  disconnectMcpConnector,
  matchesConnectorUrl,
  type McpConnector,
  type McpServerRow,
} from "./mcp-connectors";

// The server's own naming rules, read from its source so the two cannot drift
// (the renderer does not compile server modules).
const registry = readFileSync(new URL("../../server/mcp-registry.ts", import.meta.url), "utf8");
const SERVER_NAME = new RegExp(/const MCP_NAME = \/(.+)\/;/.exec(registry)![1]!);
const RESERVED = new Set([...(/const RESERVED_MCP_NAMES = new Set\(\[([\s\S]*?)\]\)/.exec(registry)![1]!.matchAll(/"([^"]+)"/g))].map((match) => match[1]!));

const byId = (id: string) => MCP_CONNECTORS.find((connector) => connector.id === id)!;
const linear = byId("linear");
const row = (extra: Partial<McpServerRow> & { name: string }): McpServerRow => ({ type: "http", headerKeys: [], enabled: false, ...extra });

describe("connector catalog", () => {
  it("records the day it was checked", () => {
    expect(MCP_CONNECTORS_CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${MCP_CONNECTORS_CHECKED_ON}T00:00:00Z`).toISOString().slice(0, 10)).toBe(MCP_CONNECTORS_CHECKED_ON);
  });

  it("gives every entry the required fields, an https endpoint and docs, and a usable server name", () => {
    expect(SERVER_NAME.test("linear")).toBe(true);
    expect(RESERVED.has("composio")).toBe(true);
    expect(MCP_CONNECTORS.length).toBeGreaterThan(0);
    for (const connector of MCP_CONNECTORS) {
      expect(SERVER_NAME.test(connector.id), connector.id).toBe(true);
      expect(RESERVED.has(connector.id), connector.id).toBe(false);
      expect(connector.name.trim(), connector.id).toBe(connector.name);
      expect(connector.name.length, connector.id).toBeGreaterThan(0);
      for (const value of [connector.url, connector.docs]) {
        const url = new URL(value);
        expect(url.protocol, value).toBe("https:");
        expect(url.username + url.password + url.search + url.hash, value).toBe("");
      }
      expect(["http", "sse"]).toContain(connector.transport);
      expect(Object.keys(MCP_CONNECTOR_CATEGORIES)).toContain(connector.category);
    }
  });

  it("describes what a dog can do with each in one short line of English copy", () => {
    // about one line of a row in the pop-up's two-column list (the rest is in its tooltip)
    const keys = [
      ...MCP_CONNECTORS.map((connector) => connector.description),
      ...MCP_CONNECTORS.flatMap((connector) => (connector.note ? [connector.note] : [])),
      ...Object.values(MCP_CONNECTOR_CATEGORIES),
    ];
    for (const key of keys) {
      const text = (en as Record<string, string>)[key];
      expect(text, key).toBeTruthy();
      expect(text, key).not.toMatch(/\n/);
      expect(text!.length, key).toBeLessThanOrEqual(64);
    }
  });

  it("lists each service once, by id, name and endpoint", () => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    expect(unique(MCP_CONNECTORS.map((connector) => connector.id))).toBe(true);
    expect(unique(MCP_CONNECTORS.map((connector) => connector.name.toLowerCase()))).toBe(true);
    expect(unique(MCP_CONNECTORS.map((connector) => connector.description))).toBe(true);
    const endpoints = MCP_CONNECTORS.map((connector) => {
      const url = new URL(connector.url);
      return `${url.host}${url.pathname.replace(/\/+$/, "")}`;
    });
    expect(unique(endpoints)).toBe(true);
    // no two entries could ever claim the same configured server
    for (const connector of MCP_CONNECTORS) {
      expect(MCP_CONNECTORS.filter((other) => matchesConnectorUrl(other, connector.url)).map((other) => other.id)).toEqual([connector.id]);
    }
  });
});

describe("recognizing a configured server", () => {
  it("matches the endpoint give or take a trailing slash, and nothing else", () => {
    expect(matchesConnectorUrl(linear, "https://mcp.linear.app/mcp")).toBe(true);
    expect(matchesConnectorUrl(linear, "https://mcp.linear.app/mcp/")).toBe(true);
    expect(matchesConnectorUrl(linear, "https://MCP.LINEAR.APP/mcp")).toBe(true);
    expect(matchesConnectorUrl(byId("stripe"), "https://mcp.stripe.com/")).toBe(true);
    for (const url of [
      "http://mcp.linear.app/mcp", "https://mcp.linear.app.evil.test/mcp", "https://linear.app/mcp", "https://mcp.linear.app/mcp/readonly",
      "https://mcp.linear.app/sse", "https://mcp.linear.app/mcp?key=secret", "https://mcp.linear.app/mcp#x", "https://user:pass@mcp.linear.app/mcp",
      "not a url", "",
    ]) expect(matchesConnectorUrl(linear, url), url).toBe(false);
    expect(matchesConnectorUrl(linear, undefined)).toBe(false);
  });

  it("reads Connected, Needs sign-in and blocked from the server's own state", () => {
    expect(connectorState(undefined)).toBe("available");
    expect(connectorState(row({ name: "linear" }))).toBe("available");
    expect(connectorState(row({ name: "linear", enabled: false, auth: "signed-in" }))).toBe("available");
    expect(connectorState(row({ name: "linear", enabled: true, auth: "signed-in" }))).toBe("connected");
    // added by hand with its own token header: already connected
    expect(connectorState(row({ name: "linear", enabled: true, headerKeys: ["Authorization"] }))).toBe("connected");
    // on, but signed out and without a token: it would only answer 401
    expect(connectorState(row({ name: "linear", enabled: true }))).toBe("needs-sign-in");
    expect(connectorState(row({ name: "linear", enabled: true, headerKeys: ["X-Team"] }))).toBe("needs-sign-in");
    expect(connectorState(row({ name: "linear", enabled: true, auth: "needs-sign-in" }))).toBe("needs-sign-in");
    expect(connectorState(row({ name: "linear", enabled: false, auth: "needs-sign-in" }))).toBe("needs-sign-in");
    expect(connectorState(row({ name: "linear", enabled: true, auth: "signed-in", managedBy: "Acme" }))).toBe("blocked");
  });

  it("finds it under any name, preferring one that works", () => {
    const servers = [
      row({ name: "notes", url: "https://mcp.notion.com/mcp", enabled: true }),
      row({ name: "linear", url: "https://mcp.linear.app/mcp", auth: "needs-sign-in" }),
      row({ name: "work-tracker", url: "https://mcp.linear.app/mcp/", enabled: true, auth: "signed-in" }),
    ];
    expect(connectorServer(linear, servers)?.name).toBe("work-tracker");
    expect(connectorServer(linear, servers.slice(0, 2))?.name).toBe("linear");
    expect(connectorServer(byId("sentry"), servers)).toBeUndefined();
  });

  it("never takes a name another server already has", () => {
    expect(connectorServerName(linear, [])).toBe("linear");
    expect(connectorServerName(linear, [{ name: "linear" }])).toBe("linear-2");
    expect(connectorServerName(linear, [{ name: "linear" }, { name: "linear-2" }])).toBe("linear-3");
    const long: McpConnector = { ...linear, id: "a".repeat(32) };
    const next = connectorServerName(long, [{ name: long.id }]);
    expect(next).toHaveLength(32);
    expect(SERVER_NAME.test(next)).toBe(true);
  });

  it("searches names, descriptions and categories", () => {
    expect(MCP_CONNECTORS.filter((connector) => connectorMatchesSearch(connector, "")).length).toBe(MCP_CONNECTORS.length);
    expect(MCP_CONNECTORS.filter((connector) => connectorMatchesSearch(connector, " LINEAR ")).map((connector) => connector.id)).toEqual(["linear"]);
    expect(MCP_CONNECTORS.filter((connector) => connectorMatchesSearch(connector, "payments")).map((connector) => connector.id)).toEqual(["paypal", "stripe"]);
    expect(MCP_CONNECTORS.filter((connector) => connectorMatchesSearch(connector, "jira")).map((connector) => connector.id)).toEqual(["atlassian"]);
    expect(MCP_CONNECTORS.some((connector) => connectorMatchesSearch(connector, "gmail"))).toBe(false);
  });
});

type Call = { path: string; method: string; body?: unknown };

/** A fake of the MCP server routes that records every request in order. */
function fakeApi(routes: Record<string, (body: unknown) => unknown>) {
  const calls: Call[] = [];
  const api = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ path, method, ...(body === undefined ? {} : { body }) });
    const route = routes[`${method} ${path}`];
    if (!route) throw new Error(`unexpected ${method} ${path}`);
    return route(body);
  });
  return { api, calls };
}

const WAITING = { phase: "waiting", flowId: "flow-1", authorizationUrl: "https://mcp.linear.app/authorize?client_id=x", expiresAt: "2026-10-08T00:05:00Z" };
const SIGNED_IN = { phase: "succeeded", flowId: "flow-1", authorizationUrl: null, expiresAt: "2026-10-08T00:05:00Z" };

describe("Connect", () => {
  it("adds the server switched off through the MCP server API, then starts the sign-in, and turns it on only after its tools load", async () => {
    const added = row({ name: "linear", url: linear.url });
    const { api, calls } = fakeApi({
      "POST /api/mcp/servers": () => ({ servers: [added] }),
      "POST /api/mcp/servers/linear/sign-in": () => ({ auth: WAITING }),
      "GET /api/mcp/servers/linear/sign-in/flow-1": () => ({ auth: SIGNED_IN }),
      "POST /api/mcp/servers/linear/test": () => ({ ok: true, tools: [{ name: "list_issues" }] }),
      "PATCH /api/mcp/servers/linear": () => ({ servers: [{ ...added, enabled: true, auth: "signed-in" }] }),
    });
    const open = vi.fn(async () => {});
    const onSignIn = vi.fn();
    const onServers = vi.fn();
    const onSignedIn = vi.fn((server: string) => {
      // signed in before its tools are checked
      expect(server).toBe("linear");
      expect(calls.map((call) => call.path)).not.toContain("/api/mcp/servers/linear/test");
    });
    const result = await connectMcpConnector(linear, [], { api, open, onSignIn, onSignedIn, onServers, sleep: async () => {} });
    expect(onSignedIn).toHaveBeenCalledOnce();

    expect(result).toEqual({ outcome: "connected", server: "linear" });
    expect(calls).toEqual([
      { path: "/api/mcp/servers", method: "POST", body: { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", enabled: false } },
      { path: "/api/mcp/servers/linear/sign-in", method: "POST" },
      { path: "/api/mcp/servers/linear/sign-in/flow-1", method: "GET" },
      { path: "/api/mcp/servers/linear/test", method: "POST" },
      { path: "/api/mcp/servers/linear", method: "PATCH", body: { enabled: true } },
    ]);
    expect(open).toHaveBeenCalledWith(WAITING.authorizationUrl);
    expect(onSignIn).toHaveBeenCalledWith("linear", WAITING, expect.any(Function));
    expect(onServers.mock.calls.map(([servers]) => servers[0].enabled)).toEqual([false, true]);
  });

  it("saves the catalog's transport", async () => {
    const webflow = byId("webflow");
    const { api, calls } = fakeApi({ "POST /api/mcp/servers": () => ({ servers: [] }) });
    await connectMcpConnector(webflow, [], { api, open: async () => {} });
    expect(calls[0]!.body).toEqual({ name: "webflow", type: "sse", url: "https://mcp.webflow.com/sse", enabled: false });
  });

  it("reuses a server already added under another name instead of adding a second", async () => {
    const existing = row({ name: "tracker", url: "https://mcp.linear.app/mcp/" });
    const { api, calls } = fakeApi({
      "POST /api/mcp/servers/tracker/sign-in": () => ({ auth: WAITING }),
      "GET /api/mcp/servers/tracker/sign-in/flow-1": () => ({ auth: SIGNED_IN }),
      "POST /api/mcp/servers/tracker/test": () => ({ ok: true, tools: [] }),
      "PATCH /api/mcp/servers/tracker": () => ({ servers: [{ ...existing, enabled: true, auth: "signed-in" }] }),
    });
    expect(await connectMcpConnector(linear, [existing], { api, open: async () => {}, sleep: async () => {} }))
      .toEqual({ outcome: "connected", server: "tracker" });
    expect(calls.some((call) => call.path === "/api/mcp/servers")).toBe(false);
  });

  it("never overwrites an unrelated server that has the connector's name", async () => {
    const { api, calls } = fakeApi({ "POST /api/mcp/servers": () => ({ servers: [] }) });
    const unrelated = { name: "linear", enabled: true } as McpServerRow;
    expect(await connectMcpConnector(linear, [unrelated], { api, open: async () => {} })).toEqual({ outcome: "failed", reason: "not-added" });
    expect(calls).toEqual([{ path: "/api/mcp/servers", method: "POST", body: { name: "linear-2", type: "http", url: linear.url, enabled: false } }]);
  });

  it("skips the sign-in for a server that is already signed in, or that carries its own token", async () => {
    for (const existing of [
      row({ name: "linear", url: linear.url, auth: "signed-in" }),
      row({ name: "linear", url: linear.url, headerKeys: ["authorization"] }),
    ]) {
      const { api, calls } = fakeApi({
        "POST /api/mcp/servers/linear/test": () => ({ ok: true, tools: [] }),
        "PATCH /api/mcp/servers/linear": () => ({ servers: [{ ...existing, enabled: true }] }),
      });
      const onSignedIn = vi.fn();
      expect(await connectMcpConnector(linear, [existing], { api, open: async () => {}, onSignedIn })).toEqual({ outcome: "connected", server: "linear" });
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/mcp/servers/linear/test", "PATCH /api/mcp/servers/linear"]);
      expect(onSignedIn).not.toHaveBeenCalled();
    }
  });

  it("stops before testing or switching on when the sign-in fails or is cancelled", async () => {
    const existing = row({ name: "linear", url: linear.url });
    const failed = fakeApi({
      "POST /api/mcp/servers/linear/sign-in": () => ({ auth: WAITING }),
      "GET /api/mcp/servers/linear/sign-in/flow-1": () => ({ auth: { ...SIGNED_IN, phase: "failed", message: "Sign-in was not approved." } }),
    });
    expect(await connectMcpConnector(linear, [existing], { api: failed.api, open: async () => {}, sleep: async () => {} }))
      .toEqual({ outcome: "failed", server: "linear", reason: "sign-in", message: "Sign-in was not approved." });
    expect(failed.calls.some((call) => call.path.endsWith("/test") || call.method === "PATCH")).toBe(false);

    const controller = new AbortController();
    const cancelled = fakeApi({
      "POST /api/mcp/servers/linear/sign-in": () => ({ auth: WAITING }),
      "DELETE /api/mcp/servers/linear/sign-in/flow-1": () => ({ ok: true }),
    });
    const open = vi.fn(async () => { controller.abort(); });
    expect(await connectMcpConnector(linear, [existing], { api: cancelled.api, open, signal: controller.signal, sleep: () => new Promise(() => {}) }))
      .toEqual({ outcome: "cancelled", server: "linear" });
    expect(cancelled.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/mcp/servers/linear/sign-in",
      "DELETE /api/mcp/servers/linear/sign-in/flow-1",
    ]);
  });

  it("leaves the server off when its tools cannot be loaded", async () => {
    const existing = row({ name: "linear", url: linear.url, auth: "signed-in" });
    for (const [answer, reason] of [[{ ok: false, error: "The server did not answer in time." }, "tools"], [{ ok: false, error: "This server needs you to sign in.", auth: "required" }, "sign-in"]] as const) {
      const { api, calls } = fakeApi({ "POST /api/mcp/servers/linear/test": () => answer });
      expect(await connectMcpConnector(linear, [existing], { api, open: async () => {} }))
        .toEqual({ outcome: "failed", server: "linear", reason, message: answer.error });
      expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    }
  });
});

describe("Disconnect", () => {
  it("switches the server off and signs out, keeping the entry for the next Connect", async () => {
    const connected = row({ name: "linear", url: linear.url, enabled: true, auth: "signed-in" });
    const { api, calls } = fakeApi({
      "PATCH /api/mcp/servers/linear": () => ({ servers: [{ ...connected, enabled: false }] }),
      "POST /api/mcp/servers/linear/sign-out": () => ({ servers: [{ ...connected, enabled: false, auth: undefined }] }),
    });
    await disconnectMcpConnector(connected, { api });
    expect(calls).toEqual([
      { path: "/api/mcp/servers/linear", method: "PATCH", body: { enabled: false } },
      { path: "/api/mcp/servers/linear/sign-out", method: "POST" },
    ]);
    const tokenOnly = fakeApi({ "PATCH /api/mcp/servers/linear": () => ({ servers: [] }) });
    await disconnectMcpConnector(row({ name: "linear", url: linear.url, enabled: true, headerKeys: ["Authorization"] }), { api: tokenOnly.api });
    expect(tokenOnly.calls.map((call) => call.method)).toEqual(["PATCH"]);
  });
});
