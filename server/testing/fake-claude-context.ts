import { appendFileSync } from "node:fs";

export type FakeContextMode = "answers" | "unknown" | "no-turn" | "silent";

export function fakeContextMode(value: string | undefined): FakeContextMode {
  return value === "unknown" || value === "no-turn" || value === "silent" ? value : "answers";
}

export function fakeContextUsage(turns: number) {
  const messages = 4_000 + turns * 1_500;
  const used = 3_200 + 18_000 + 2_500 + 1_200 + 900 + messages;
  const window = 200_000;
  const buffer = 33_000;
  return {
    categories: [
      { id: "system_prompt", name: "System prompt", tokens: 3_200, color: "promptBorder", kind: "used" },
      { id: "system_tools", name: "System tools", tokens: 18_000, color: "inactive", kind: "used" },
      { id: "mcp_tools", name: "MCP tools", tokens: 2_500, color: "cyan_FOR_SUBAGENTS_ONLY", kind: "used" },
      { id: "mcp_tools_deferred", name: "MCP tools (deferred)", tokens: 41_000, color: "inactive", isDeferred: true, kind: "deferred" },
      { id: "memory_files", name: "Memory files", tokens: 1_200, color: "claude", kind: "used" },
      { id: "skills", name: "Skills", tokens: 900, color: "warning", kind: "used" },
      { id: "messages", name: "Messages", tokens: messages, color: "purple_FOR_SUBAGENTS_ONLY", kind: "used" },
      { id: "autocompact_buffer", name: "Autocompact buffer", tokens: buffer, color: "inactive", kind: "buffer" },
      { id: "free_space", name: "Free space", tokens: window - used - buffer, color: "promptBorder", kind: "free" },
    ],
    totalTokens: used,
    maxTokens: window,
    rawMaxTokens: window,
    autocompactSource: "model-default",
    percentage: Math.round((used / window) * 100),
    gridRows: [],
    model: "claude-fake",
    memoryFiles: [{ path: "/Users/fixture-person/private-project/CLAUDE.md", type: "Project", tokens: 1_200 }],
    mcpTools: [{ name: "mcp__agents__fixture_private_tool", serverName: "agents", tokens: 2_500, isLoaded: true }],
    agents: [],
    autoCompactThreshold: window - buffer,
    isAutoCompactEnabled: true,
    messageBreakdown: {
      toolCallTokens: 0, toolResultTokens: 0, attachmentTokens: 0, assistantMessageTokens: messages / 2, userMessageTokens: messages / 2,
      toolCallsByType: [{ name: "FixturePrivateCommand", callTokens: 1, resultTokens: 1 }], attachmentsByType: [],
    },
    apiUsage: null,
  };
}

export function answerControlRequest(
  line: unknown,
  state: { mode: FakeContextMode; turnsPlayed: number; seenFile?: string },
  out: (message: unknown) => void,
): boolean {
  if (!line || typeof line !== "object" || (line as { type?: unknown }).type !== "control_request") return false;
  const { request_id: requestId, request } = line as { request_id?: unknown; request?: { subtype?: unknown; detail?: unknown } };
  if (state.seenFile) appendFileSync(state.seenFile, `${JSON.stringify({ subtype: request?.subtype, detail: request?.detail, turns: state.turnsPlayed })}\n`);
  if (state.mode === "silent") return true;
  if (request?.subtype !== "get_context_usage" || state.mode === "unknown") {
    out({ type: "control_response", response: { subtype: "error", request_id: requestId, error: `Unsupported control request subtype: ${String(request?.subtype)}` } });
    return true;
  }
  if (state.mode === "no-turn" && state.turnsPlayed === 0) {
    out({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "getContextUsage: no turn received yet" } });
    return true;
  }
  out({ type: "control_response", response: { subtype: "success", request_id: requestId, response: fakeContextUsage(state.turnsPlayed) } });
  return true;
}
