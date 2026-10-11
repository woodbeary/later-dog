export const LATERDOG_MCP_SERVER = "laterdog";

export const LATERDOG_PREALLOWED_TOOLS = [
  "laterdog_workspace",
  "inspect_provider_access",
  "list_provider_tasks",
  "record_job_observation",
  "delegate_cloud_job",
  "inspect_cloud_job",
  "collect_cloud_diff",
  "publish_cloud_job",
  "verify_cloud_job",
  "cancel_cloud_job",
  "review_cloud_job",
  "correct_cloud_job",
  "reconcile_cloud_task",
  "inspect_local_assistance",
] as const;

export function isLaterdogMcp(server: unknown): boolean {
  if (!server || typeof server !== "object") return false;
  const args = (server as { args?: unknown }).args;
  return Array.isArray(args) && args.some((arg) => typeof arg === "string" && /[/\\]laterdog[/\\]mcp\.(ts|js)"?$/.test(arg));
}

export function laterdogPreallowedTools(servers: Record<string, unknown>, mounted: Record<string, unknown>): string[] {
  if (!Object.hasOwn(mounted, LATERDOG_MCP_SERVER) || !isLaterdogMcp(servers[LATERDOG_MCP_SERVER])) return [];
  return LATERDOG_PREALLOWED_TOOLS.map((tool) => `mcp__${LATERDOG_MCP_SERVER}__${tool}`);
}
