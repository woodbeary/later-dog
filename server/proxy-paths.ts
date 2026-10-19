import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));

export function resolveProxy(relative: string): string {
  const source = join(SERVER_ROOT, `${relative}.ts`);
  return existsSync(source) ? source : join(SERVER_ROOT, `${relative}.js`);
}

export const SPAWNED_PROXIES = {
  harnessMcp: resolveProxy("harness-mcp-proxy"),
  localComputer: resolveProxy("local-computer-proxy"),
  permission: resolveProxy("permission-proxy"),
  containerMcp: resolveProxy("container-mcp"),
  vpsContainerMcp: resolveProxy("vps-container-mcp"),
  agents: resolveProxy("drivers/agents-proxy"),
  connectors: resolveProxy("connector-proxy"),
  mcpGate: resolveProxy("mcp-gate"),
  mcpRemote: resolveProxy("mcp-remote-proxy"),
  hook: resolveProxy("hooks/laterdog-hook"),
  piMcpExtension: resolveProxy("drivers/pi-mcp-extension"),
} as const;
