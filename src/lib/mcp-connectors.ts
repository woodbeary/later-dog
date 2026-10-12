import { t } from "@/lib/i18n";
import { runMcpSignIn, type McpSignInStatus } from "@/lib/mcp-sign-in";
import type { LocaleKey } from "@/locales";

export const MCP_CONNECTORS_CHECKED_ON = "2026-10-08";

export type McpConnectorCategory =
  | "projects"
  | "docs"
  | "monitoring"
  | "cloud"
  | "databases"
  | "payments"
  | "support"
  | "websites";

export interface McpConnector {
  id: string;
  name: string;
  description: LocaleKey;
  note?: LocaleKey;
  url: string;
  transport: "http" | "sse";
  category: McpConnectorCategory;
  docs: string;
}

export const MCP_CONNECTOR_CATEGORIES: Record<McpConnectorCategory, LocaleKey> = {
  projects: "mcpConnectors.category.projects",
  docs: "mcpConnectors.category.docs",
  monitoring: "mcpConnectors.category.monitoring",
  cloud: "mcpConnectors.category.cloud",
  databases: "mcpConnectors.category.databases",
  payments: "mcpConnectors.category.payments",
  support: "mcpConnectors.category.support",
  websites: "mcpConnectors.category.websites",
};

export const MCP_CONNECTORS: readonly McpConnector[] = [
  {
    id: "atlassian",
    name: "Atlassian",
    description: "mcpConnectors.atlassian.description",
    url: "https://mcp.atlassian.com/v2/mcp",
    transport: "http",
    category: "projects",
    docs: "https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "mcpConnectors.cloudflare.description",
    url: "https://mcp.cloudflare.com/mcp",
    transport: "http",
    category: "cloud",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
  },
  {
    id: "intercom",
    name: "Intercom",
    description: "mcpConnectors.intercom.description",
    note: "mcpConnectors.intercom.note",
    url: "https://mcp.intercom.com/mcp",
    transport: "http",
    category: "support",
    docs: "https://developers.intercom.com/docs/guides/mcp",
  },
  {
    id: "linear",
    name: "Linear",
    description: "mcpConnectors.linear.description",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
    category: "projects",
    docs: "https://linear.app/docs/mcp",
  },
  {
    id: "neon",
    name: "Neon",
    description: "mcpConnectors.neon.description",
    note: "mcpConnectors.neon.note",
    url: "https://mcp.neon.tech/mcp",
    transport: "http",
    category: "databases",
    docs: "https://neon.com/docs/ai/neon-mcp-server",
  },
  {
    id: "notion",
    name: "Notion",
    description: "mcpConnectors.notion.description",
    url: "https://mcp.notion.com/mcp",
    transport: "http",
    category: "docs",
    docs: "https://developers.notion.com/docs/get-started-with-mcp",
  },
  {
    id: "paypal",
    name: "PayPal",
    description: "mcpConnectors.paypal.description",
    url: "https://mcp.paypal.com/mcp",
    transport: "http",
    category: "payments",
    docs: "https://developer.paypal.com/tools/mcp-server/",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "mcpConnectors.sentry.description",
    url: "https://mcp.sentry.dev/mcp",
    transport: "http",
    category: "monitoring",
    docs: "https://docs.sentry.io/product/sentry-mcp/",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "mcpConnectors.stripe.description",
    url: "https://mcp.stripe.com",
    transport: "http",
    category: "payments",
    docs: "https://docs.stripe.com/mcp",
  },
  {
    id: "webflow",
    name: "Webflow",
    description: "mcpConnectors.webflow.description",
    url: "https://mcp.webflow.com/sse",
    transport: "sse",
    category: "websites",
    docs: "https://developers.webflow.com/data/docs/ai-tools",
  },
];

export interface McpServerRow {
  name: string;
  url?: string;
  type?: "http" | "sse";
  enabled: boolean;
  auth?: "signed-in" | "needs-sign-in";
  headerKeys?: string[];
  managedBy?: string;
}

export type McpConnectorState = "available" | "connected" | "needs-sign-in" | "blocked";

function endpoint(value: string): { host: string; path: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return { host: url.host, path: url.pathname.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

export function matchesConnectorUrl(connector: Pick<McpConnector, "url">, url: string | undefined): boolean {
  if (!url) return false;
  const want = endpoint(connector.url);
  const have = endpoint(url);
  return Boolean(want && have && want.host === have.host && want.path === have.path);
}

function hasAuthorizationHeader(server: McpServerRow): boolean {
  return (server.headerKeys ?? []).some((key) => key.toLowerCase() === "authorization");
}

export function connectorState(server: McpServerRow | undefined): McpConnectorState {
  if (!server) return "available";
  if (server.managedBy) return "blocked";
  if (server.auth === "needs-sign-in") return "needs-sign-in";
  if (!server.enabled) return "available";
  return server.auth === "signed-in" || hasAuthorizationHeader(server) ? "connected" : "needs-sign-in";
}

const STATE_RANK: Record<McpConnectorState, number> = { connected: 0, "needs-sign-in": 1, available: 2, blocked: 3 };

export function connectorServer(connector: McpConnector, servers: readonly McpServerRow[]): McpServerRow | undefined {
  return servers
    .filter((server) => matchesConnectorUrl(connector, server.url))
    .map((server, index) => ({ server, index }))
    .sort((a, b) => STATE_RANK[connectorState(a.server)] - STATE_RANK[connectorState(b.server)] || a.index - b.index)[0]?.server;
}

export function connectorServerName(connector: McpConnector, servers: readonly { name: string }[]): string {
  const names = new Set(servers.map((server) => server.name));
  let name = connector.id;
  for (let suffix = 2; names.has(name); suffix++) name = `${connector.id.slice(0, 31 - String(suffix).length)}-${suffix}`;
  return name;
}

export function connectorMatchesSearch(connector: McpConnector, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [connector.name, connector.id, t(connector.description), t(MCP_CONNECTOR_CATEGORIES[connector.category])]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

type Api = (path: string, init?: { method?: string; body?: string }) => Promise<any>;

export interface ConnectDeps {
  api: Api;
  open: (url: string) => Promise<void>;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  onServers?: (servers: McpServerRow[]) => void;
  onSignIn?: (server: string, status: McpSignInStatus, complete: (result: McpSignInStatus) => void) => void;
  onSignedIn?: (server: string) => void;
}

export type ConnectResult =
  | { outcome: "connected"; server: string }
  | { outcome: "cancelled"; server?: string }
  | { outcome: "failed"; server?: string; reason: "not-added" | "sign-in" | "tools"; message?: string };

const serverPath = (name: string) => `/api/mcp/servers/${encodeURIComponent(name)}`;

export async function connectMcpConnector(
  connector: McpConnector,
  servers: readonly McpServerRow[],
  deps: ConnectDeps,
): Promise<ConnectResult> {
  let server = connectorServer(connector, servers);
  if (!server) {
    const name = connectorServerName(connector, servers);
    const added = await deps.api("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify({ name, type: connector.transport, url: connector.url, enabled: false }),
    });
    const list: McpServerRow[] = added?.servers ?? [];
    deps.onServers?.(list);
    server = list.find((row) => row.name === name && matchesConnectorUrl(connector, row.url));
    if (!server) return { outcome: "failed", reason: "not-added" };
  }
  const name = server.name;
  if (deps.signal?.aborted) return { outcome: "cancelled", server: name };
  if (server.auth !== "signed-in" && !hasAuthorizationHeader(server)) {
    const signedIn = await runMcpSignIn(name, {
      api: deps.api,
      open: deps.open,
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      onStarted: (status, complete) => deps.onSignIn?.(name, status, complete),
    });
    if (signedIn.phase === "cancelled") return { outcome: "cancelled", server: name };
    if (signedIn.phase !== "succeeded") {
      return { outcome: "failed", server: name, reason: "sign-in", ...(signedIn.message ? { message: signedIn.message } : {}) };
    }
    deps.onSignedIn?.(name);
  }
  if (deps.signal?.aborted) return { outcome: "cancelled", server: name };
  const tested = await deps.api(`${serverPath(name)}/test`, { method: "POST" });
  if (deps.signal?.aborted) return { outcome: "cancelled", server: name };
  if (!tested?.ok) {
    return {
      outcome: "failed",
      server: name,
      reason: tested?.auth === "required" ? "sign-in" : "tools",
      ...(typeof tested?.error === "string" ? { message: tested.error } : {}),
    };
  }
  const enabled = await deps.api(serverPath(name), { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  deps.onServers?.(enabled?.servers ?? []);
  return { outcome: "connected", server: name };
}

export async function disconnectMcpConnector(server: McpServerRow, deps: Pick<ConnectDeps, "api" | "onServers">): Promise<void> {
  const paused = await deps.api(serverPath(server.name), { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  deps.onServers?.(paused?.servers ?? []);
  if (server.auth !== "signed-in") return;
  const signedOut = await deps.api(`${serverPath(server.name)}/sign-out`, { method: "POST" });
  deps.onServers?.(signedOut?.servers ?? []);
}
