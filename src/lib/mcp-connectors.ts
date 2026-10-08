// Connectors: official remote MCP servers that sign in with OAuth, offered
// in the Apps pop-up as one-click cards. Connect adds the server through the
// ordinary MCP server API (POST /api/mcp/servers, saved off), runs the
// ordinary sign-in (lib/mcp-sign-in.ts), tests it and only then turns it on,
// so a dog reaches it through the normal MCP path with no engine changes.
//
// Checked on MCP_CONNECTORS_CHECKED_ON. An entry is listed only when:
// 1. its URL is the one the provider's own MCP docs or the MCP registry gives;
// 2. the provider documents an OAuth sign-in that any MCP client may use;
// 3. its published OAuth metadata passes later.dog's own discovery
//    (server/mcp-oauth-discovery.ts): PKCE S256, a protected resource that
//    names this URL, and a registration endpoint that admits public clients
//    (`none` among the token endpoint's auth methods), because later.dog
//    registers itself for each sign-in and keeps no client secret.
// Left out on that date, and why:
// - Asana: its current server (mcp.asana.com/v2/mcp) has no registration
//   endpoint (a client ID and secret come from Asana's integration guide), and
//   the beta /sse server is deprecated with a shutdown date of "05/11/2026".
// - Vercel: only clients Vercel has reviewed and approved may connect.
// - Supabase, Hugging Face, monday.com, Figma: their authorization servers
//   list only token auth methods that need a client secret, and later.dog
//   registers a public client without one.
// - Canva: dynamic registration is deprecated in favour of client metadata
//   documents, and secretless clients need Canva to allowlist their redirect.
// - Square: Square keeps an allowlist of MCP clients.
// - Box: an admin creates the app and hands out its client ID and secret.
// - Airtable: its protected resource is the bare origin, while later.dog sends
//   the MCP URL as the resource, so the sign-in cannot be counted on.
// - GitHub, Slack, HubSpot: no registration endpoint; an app must be
//   registered in advance and its client ID pasted.
// Fixture success does not qualify a live provider: each entry still needs a
// person to click Connect and finish the provider's consent.
import { t } from "@/lib/i18n";
import { runMcpSignIn, type McpSignInStatus } from "@/lib/mcp-sign-in";
import type { LocaleKey } from "@/locales";

/** The day every entry's URL, docs and OAuth metadata were last checked. */
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
  /** The MCP server name Connect saves it under (another is picked if taken). */
  id: string;
  /** The provider's own name; never translated. */
  name: string;
  /** One line: what a dog can do with it. */
  description: LocaleKey;
  /** A limitation the provider states, shown on the card. */
  note?: LocaleKey;
  /** The official MCP endpoint. */
  url: string;
  /** Streamable HTTP, or the older SSE transport that Codex dogs skip. */
  transport: "http" | "sse";
  category: McpConnectorCategory;
  /** The provider's MCP documentation. */
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
    // PayPal's page names /http for streamable HTTP, which answered 404 on
    // the check date; the registry's /mcp is the live endpoint.
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
    // Webflow documents only its SSE endpoint.
    id: "webflow",
    name: "Webflow",
    description: "mcpConnectors.webflow.description",
    url: "https://mcp.webflow.com/sse",
    transport: "sse",
    category: "websites",
    docs: "https://developers.webflow.com/data/docs/ai-tools",
  },
];

/** One row of GET /api/mcp/servers, as far as connectors need it. */
export interface McpServerRow {
  name: string;
  url?: string;
  type?: "http" | "sse";
  enabled: boolean;
  /** present once the server has a sign-in record */
  auth?: "signed-in" | "needs-sign-in";
  headerKeys?: string[];
  /** the enrolled organization has not approved this server */
  managedBy?: string;
}

/** What a card says about its connector, read from the server's own state. */
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

/** The same endpoint as the connector's, give or take a trailing slash. A
 * query, credentials or another path is a different server. */
export function matchesConnectorUrl(connector: Pick<McpConnector, "url">, url: string | undefined): boolean {
  if (!url) return false;
  const want = endpoint(connector.url);
  const have = endpoint(url);
  return Boolean(want && have && want.host === have.host && want.path === have.path);
}

/** A server already carrying its own Authorization header needs no sign-in. */
function hasAuthorizationHeader(server: McpServerRow): boolean {
  return (server.headerKeys ?? []).some((key) => key.toLowerCase() === "authorization");
}

/** Every catalog server needs a credential: its OAuth sign-in, or a token
 * header someone added by hand. One that is on without either (signed out
 * from the server list, say) only answers 401, so it needs a sign-in. */
export function connectorState(server: McpServerRow | undefined): McpConnectorState {
  if (!server) return "available";
  if (server.managedBy) return "blocked";
  if (server.auth === "needs-sign-in") return "needs-sign-in";
  if (!server.enabled) return "available";
  return server.auth === "signed-in" || hasAuthorizationHeader(server) ? "connected" : "needs-sign-in";
}

const STATE_RANK: Record<McpConnectorState, number> = { connected: 0, "needs-sign-in": 1, available: 2, blocked: 3 };

/** The configured server behind a connector, under whatever name it was
 * added: a working one first, then one waiting for sign-in. */
export function connectorServer(connector: McpConnector, servers: readonly McpServerRow[]): McpServerRow | undefined {
  return servers
    .filter((server) => matchesConnectorUrl(connector, server.url))
    .map((server, index) => ({ server, index }))
    .sort((a, b) => STATE_RANK[connectorState(a.server)] - STATE_RANK[connectorState(b.server)] || a.index - b.index)[0]?.server;
}

/** The connector's own id, or the first free id-2, id-3…: Connect never
 * overwrites an unrelated server that happens to have that name. */
export function connectorServerName(connector: McpConnector, servers: readonly { name: string }[]): string {
  const names = new Set(servers.map((server) => server.name));
  let name = connector.id;
  // a server name is at most 32 characters
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
  /** every server list the API answers with along the way */
  onServers?: (servers: McpServerRow[]) => void;
  /** the browser sign-in is waiting; `complete` takes a pasted-back result */
  onSignIn?: (server: string, status: McpSignInStatus, complete: (result: McpSignInStatus) => void) => void;
  /** the sign-in finished; its tools are being checked next */
  onSignedIn?: (server: string) => void;
}

export type ConnectResult =
  | { outcome: "connected"; server: string }
  | { outcome: "cancelled"; server?: string }
  | { outcome: "failed"; server?: string; reason: "not-added" | "sign-in" | "tools"; message?: string };

const serverPath = (name: string) => `/api/mcp/servers/${encodeURIComponent(name)}`;

/** Add (or reuse) the connector's server, sign in, prove its tools load,
 * then turn it on. A server is switched on only after all of that worked,
 * so a half-finished connection never reaches a dog. */
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

/** Switch the connector's server off and sign out of it. The entry stays,
 * so Connect picks it up again. */
export async function disconnectMcpConnector(server: McpServerRow, deps: Pick<ConnectDeps, "api" | "onServers">): Promise<void> {
  const paused = await deps.api(serverPath(server.name), { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  deps.onServers?.(paused?.servers ?? []);
  if (server.auth !== "signed-in") return;
  const signedOut = await deps.api(`${serverPath(server.name)}/sign-out`, { method: "POST" });
  deps.onServers?.(signedOut?.servers ?? []);
}
