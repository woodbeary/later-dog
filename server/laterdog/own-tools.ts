export const LATERDOG_MCP_SERVER = "laterdog";

export const LATERDOG_DOG_TOOLS = ["delegate_cloud_job", "inspect_cloud_job", "publish_cloud_job"] as const;

export function isLaterdogMcp(server: unknown): boolean {
  if (!server || typeof server !== "object") return false;
  const args = (server as { args?: unknown }).args;
  return Array.isArray(args) && args.some((arg) => typeof arg === "string" && /[/\\]laterdog[/\\]mcp\.(ts|js)"?$/.test(arg));
}

export function laterdogPreallowedTools(servers: Record<string, unknown>, mounted: Record<string, unknown>): string[] {
  if (!Object.hasOwn(mounted, LATERDOG_MCP_SERVER) || !isLaterdogMcp(servers[LATERDOG_MCP_SERVER])) return [];
  return LATERDOG_DOG_TOOLS.map((tool) => `mcp__${LATERDOG_MCP_SERVER}__${tool}`);
}
