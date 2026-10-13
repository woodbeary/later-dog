import { t } from "@/lib/i18n";
import { MCP_CONNECTOR_CATEGORIES, type McpConnector } from "@/lib/mcp-connector-catalog";
import { runMcpSignIn, type McpSignInStatus } from "@/lib/mcp-sign-in";

export {
  MCP_CONNECTOR_CATEGORIES,
  MCP_CONNECTORS,
  MCP_CONNECTORS_CHECKED_ON,
  type McpConnector,
  type McpConnectorCategory,
} from "@/lib/mcp-connector-catalog";

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

export function connectorState(server: McpServerRow | undefined, connector?: Pick<McpConnector, "open">): McpConnectorState {
  if (!server) return "available";
  if (server.managedBy) return "blocked";
  if (server.auth === "needs-sign-in") return "needs-sign-in";
  if (!server.enabled) return "available";
  return connector?.open || server.auth === "signed-in" || hasAuthorizationHeader(server) ? "connected" : "needs-sign-in";
}

const STATE_RANK: Record<McpConnectorState, number> = { connected: 0, "needs-sign-in": 1, available: 2, blocked: 3 };

export function connectorServer(connector: McpConnector, servers: readonly McpServerRow[]): McpServerRow | undefined {
  return servers
    .filter((server) => matchesConnectorUrl(connector, server.url))
    .map((server, index) => ({ server, index }))
    .sort((a, b) => STATE_RANK[connectorState(a.server, connector)] - STATE_RANK[connectorState(b.server, connector)] || a.index - b.index)[0]?.server;
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
  const signIn = async (): Promise<ConnectResult | undefined> => {
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
    return undefined;
  };
  const open = connector.open && server.auth !== "needs-sign-in";
  if (!open && server.auth !== "signed-in" && !hasAuthorizationHeader(server)) {
    const stopped = await signIn();
    if (stopped) return stopped;
  }
  if (deps.signal?.aborted) return { outcome: "cancelled", server: name };
  let tested = await deps.api(`${serverPath(name)}/test`, { method: "POST" });
  if (deps.signal?.aborted) return { outcome: "cancelled", server: name };
  if (open && !tested?.ok && tested?.auth === "required") {
    const stopped = await signIn();
    if (stopped) return stopped;
    if (deps.signal?.aborted) return { outcome: "cancelled", server: name };
    tested = await deps.api(`${serverPath(name)}/test`, { method: "POST" });
    if (deps.signal?.aborted) return { outcome: "cancelled", server: name };
  }
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
