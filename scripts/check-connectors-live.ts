import { discoverMcpAuth } from "../server/mcp-oauth-discovery.ts";
import { MCP_CONNECTORS, type McpConnector } from "../src/lib/mcp-connector-catalog.ts";

const TIMEOUT_MS = 15_000;
const PARALLEL = 6;

export type LiveResult =
  | { id: string; verdict: "one-click"; detail: string }
  | { id: string; verdict: "open"; detail: string }
  | { id: string; verdict: "needs-client-id" | "no-oauth" | "unreachable" | "refused"; detail: string };

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "later.dog", version: "1" } },
});

const listTools = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

function post(url: string, body: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function firstAnswer(connector: McpConnector): Promise<Response> {
  if (connector.transport === "sse") {
    return fetch(connector.url, { headers: { accept: "text/event-stream" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  }
  const answer = await post(connector.url, initialize);
  if (!answer.ok || connector.open) return answer;
  void answer.body?.cancel().catch(() => {});
  return post(connector.url, listTools);
}

export async function checkConnector(connector: McpConnector): Promise<LiveResult> {
  let response: Response;
  try {
    response = await firstAnswer(connector);
  } catch (error) {
    return { id: connector.id, verdict: "unreachable", detail: String((error as Error).cause ?? (error as Error).message).slice(0, 120) };
  }
  const challenge = response.headers.get("www-authenticate");
  void response.body?.cancel().catch(() => {});
  if (connector.open) {
    return response.ok
      ? { id: connector.id, verdict: "open", detail: `HTTP ${response.status}` }
      : { id: connector.id, verdict: "refused", detail: `listed as open, answered HTTP ${response.status}` };
  }
  if (response.status !== 401) {
    return { id: connector.id, verdict: response.ok ? "no-oauth" : "refused", detail: `HTTP ${response.status} without a sign-in challenge` };
  }
  const meta = await discoverMcpAuth(connector.url, challenge);
  if (!meta) return { id: connector.id, verdict: "no-oauth", detail: "401, but no usable OAuth metadata (PKCE S256, issuer and HTTPS endpoints)" };
  if (!meta.registrationEndpoint) return { id: connector.id, verdict: "needs-client-id", detail: `issuer ${meta.issuer} has no registration endpoint` };
  return { id: connector.id, verdict: "one-click", detail: `issuer ${meta.issuer}` };
}

if (import.meta.main) {
  const only = process.argv.slice(2);
  const queue = MCP_CONNECTORS.filter((connector) => only.length === 0 || only.includes(connector.id));
  const results: LiveResult[] = [];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let connector = queue.shift(); connector; connector = queue.shift()) results.push(await checkConnector(connector));
  }));
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), counts, problems: results.filter((r) => r.verdict !== "one-click" && r.verdict !== "open").sort((a, b) => a.id.localeCompare(b.id)) }, null, 2));
}
