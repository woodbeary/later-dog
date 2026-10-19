export const READ_ONLY_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_bots",
  "list_shared_computers",
  "session_search",
  "session_read",
  "tool_result_read",
  "list_routines",
  "skills_list",
]);

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const);

export function isReadOnlyAgentTool(name: string): boolean {
  return READ_ONLY_AGENT_TOOL_NAMES.has(name);
}

export function agentToolAnnotations(name: string): typeof READ_ONLY_ANNOTATIONS | undefined {
  return isReadOnlyAgentTool(name) ? READ_ONLY_ANNOTATIONS : undefined;
}
