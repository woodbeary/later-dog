export const READ_ONLY_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_bots",
  "list_shared_computers",
  "read_phone",
  "read_texts",
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

export const SELF_ASKING_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["send_text", "send_email"]);

export function asksForItself(name: string): boolean {
  return SELF_ASKING_AGENT_TOOL_NAMES.has(name);
}

export function isReadOnlyAgentTool(name: string): boolean {
  return READ_ONLY_AGENT_TOOL_NAMES.has(name);
}

export function agentToolAnnotations(name: string): typeof READ_ONLY_ANNOTATIONS | undefined {
  return isReadOnlyAgentTool(name) ? READ_ONLY_ANNOTATIONS : undefined;
}
