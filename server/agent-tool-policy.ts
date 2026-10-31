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

export const OPEN_WORLD_READ_TOOL_NAMES: ReadonlySet<string> = new Set(["nearby_places"]);

interface ReadOnlyAnnotations {
  readonly readOnlyHint: true;
  readonly destructiveHint: false;
  readonly idempotentHint: true;
  readonly openWorldHint: boolean;
}

const READ_ONLY_ANNOTATIONS: ReadOnlyAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const OPEN_WORLD_READ_ANNOTATIONS: ReadOnlyAnnotations = Object.freeze({ ...READ_ONLY_ANNOTATIONS, openWorldHint: true });

export const SELF_ASKING_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["send_text", "send_email"]);

export function asksForItself(name: string): boolean {
  return SELF_ASKING_AGENT_TOOL_NAMES.has(name);
}

export function isReadOnlyAgentTool(name: string): boolean {
  return READ_ONLY_AGENT_TOOL_NAMES.has(name) || OPEN_WORLD_READ_TOOL_NAMES.has(name);
}

export function agentToolAnnotations(name: string): ReadOnlyAnnotations | undefined {
  if (OPEN_WORLD_READ_TOOL_NAMES.has(name)) return OPEN_WORLD_READ_ANNOTATIONS;
  return READ_ONLY_AGENT_TOOL_NAMES.has(name) ? READ_ONLY_ANNOTATIONS : undefined;
}
