import { describe, expect, it } from "vitest";
import { agentToolAnnotations, asksForItself, isReadOnlyAgentTool, OPEN_WORLD_READ_TOOL_NAMES, READ_ONLY_AGENT_TOOL_NAMES } from "./agent-tool-policy.ts";

describe("built-in agent tool read policy", () => {
  it("includes only the reviewed local reads", () => {
    expect([...READ_ONLY_AGENT_TOOL_NAMES]).toEqual([
      "execution_advice",
      "list_bots",
      "account_usage",
      "list_shared_computers",
      "read_phone",
      "read_texts",
      "session_search",
      "session_read",
      "tool_result_read",
      "list_routines",
      "skills_list",
    ]);
    for (const name of READ_ONLY_AGENT_TOOL_NAMES) {
      expect(isReadOnlyAgentTool(name)).toBe(true);
      expect(agentToolAnnotations(name)).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it("reads public places and the person's own connected mail without asking, and marks both as coming from outside later.dog", () => {
    expect([...OPEN_WORLD_READ_TOOL_NAMES]).toEqual(["nearby_places", "gmail_search", "gmail_read"]);
    for (const name of ["nearby_places", "gmail_search", "gmail_read"]) {
      expect(isReadOnlyAgentTool(name)).toBe(true);
      expect(agentToolAnnotations(name)).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    }
  });

  it.each([
    "shared_computer", "add_to_phone", "change_on_phone", "send_text", "send_email", "coordinate_bots", "post_to_room",
    "create_bot", "request_credential", "memory_update", "propose_routine",
    "propose_routine_action", "propose_profile", "skill_manage",
    "propose_team_setup", "propose_bot_deletion",
    "gmail_send_email", "gmail_code_to_vault",
    "list_secrets", "read_credentials", "list_bots_and_delete", "unknown", "",
    "mcp__agents__list_bots", "agents.list_bots", "LIST_BOTS", " list_bots",
  ])("does not infer read access for %s", (name) => {
    expect(isReadOnlyAgentTool(name)).toBe(false);
    expect(agentToolAnnotations(name)).toBeUndefined();
  });

  it("lets texts and emails from the Mac skip the engine's own ask, because each one shows the person its exact words first", () => {
    expect(asksForItself("send_text")).toBe(true);
    expect(asksForItself("send_email")).toBe(true);
    for (const name of ["read_texts", "shared_computer", "add_to_phone", "email_me", "mcp__agents__send_text", ""]) expect(asksForItself(name)).toBe(false);
  });
});
