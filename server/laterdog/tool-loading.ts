export const DEFER_RARE_TOOLS_SETTING = "LATERDOG_DEFER_RARE_TOOLS";
export const AGENTS_DEFER_RARE_ENV = "LATERDOG_AGENTS_DEFER_RARE";
export const ALWAYS_LOAD_META = "anthropic/alwaysLoad";

export const CORE_AGENT_TOOLS: readonly string[] = [
  "coordinate_bots",
  "session_search",
  "session_read",
  "memory_update",
  "memory_log",
  "react",
  "set_plan",
  "tool_result_read",
  "run_on_computer",
  "select_computer",
  "request_credential",
  "vault_secret",
  "request_takeover",
  "attach_file",
  "start_tasks",
  "list_bots",
  "create_options_card",
];

export const RARE_AGENT_TOOLS: readonly string[] = [
  "propose_routine",
  "propose_routine_action",
  "list_routines",
  "shared_computer",
  "list_shared_computers",
  "add_mcp_server",
  "propose_profile",
  "propose_model",
  "skill_manage",
  "skills_list",
  "create_bot",
  "dog_queue",
  "dog_accounts",
  "request_device_approval",
  "read_phone",
  "add_to_phone",
  "change_on_phone",
  "email_me",
  "send_email",
  "nearby_places",
  "gmail_code_to_vault",
  "gmail_search",
  "gmail_read",
  "connect_google",
  "manage_room",
  "create_room",
  "send_voice_note",
  "execution_advice",
  "read_texts",
  "send_text",
  "account_usage",
  "switch_account",
];

const RARE = new Set(RARE_AGENT_TOOLS);

export function deferRareToolsEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  return env[DEFER_RARE_TOOLS_SETTING] !== "0";
}

export function agentsServerLaunch<T extends { env?: Record<string, string> }>(server: T, deferRare: boolean): T & { alwaysLoad: true } {
  if (!deferRare) return { ...server, alwaysLoad: true };
  return { ...server, env: { ...server.env, [AGENTS_DEFER_RARE_ENV]: "1" }, alwaysLoad: true };
}

export function withToolLoading<T extends { name: string }>(
  tools: readonly T[],
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): T[] {
  if (env[AGENTS_DEFER_RARE_ENV] !== "1") return [...tools];
  return tools.map((tool) => RARE.has(tool.name) ? { ...tool, _meta: { [ALWAYS_LOAD_META]: false } } : tool);
}
