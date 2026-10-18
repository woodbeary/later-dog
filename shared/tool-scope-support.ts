import { narrowsNativeTools, parseToolScope, type ToolScope } from "./tool-scope.ts";

export const TOOL_SCOPE_SUPPORT = {
  grok: "native-and-mcp", grokAgent: "native-and-mcp", "openai-compat": "native-and-mcp", laterdogAi: "native-and-mcp", laterdogGrok: "native-and-mcp",
  claudeAgent: "mcp", codex: "mcp", cursorAgent: "mcp",
} as const;

export function assertToolScopeSupported(engine: string, value: unknown): ToolScope | undefined {
  const parsed = parseToolScope(value);
  if (!parsed.ok) throw new Error(parsed.error);
  const support: (typeof TOOL_SCOPE_SUPPORT)[keyof typeof TOOL_SCOPE_SUPPORT] | undefined =
    TOOL_SCOPE_SUPPORT[engine as keyof typeof TOOL_SCOPE_SUPPORT];
  if (parsed.scope !== undefined && support !== "native-and-mcp") {
    if (support === undefined) {
      if (parsed.scope.allow !== undefined || parsed.scope.deny?.length) throw new Error(`${engine}: tool selection is not supported by this engine. Choose a supported engine.`);
    } else if (narrowsNativeTools(parsed.scope)) {
      throw new Error(`${engine}: native tool selection is not supported by this engine. Keep native:* in the selection or choose a supported engine.`);
    }
  }
  return parsed.scope;
}
