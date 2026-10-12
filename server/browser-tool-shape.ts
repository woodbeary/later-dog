import { trimResultText } from "./mcp-trim.ts";

export const HARNESS_OWNED_BROWSER_PARAMS: ReadonlySet<string> = new Set([
  "allowedDomains", "caCert", "clearCaCert", "extraArgs", "headed", "idleTimeout", "namespace",
  "restore", "restoreCheckFn", "restoreCheckText", "restoreCheckUrl", "restoreSave", "session", "timeoutMs",
]);

export const DEFAULT_BROWSER_RESULT_BUDGET = 32_000;

const BROWSER_NARROWING_HINT =
  " For a snapshot, pass selector or depth, or set compact; for one value such as a price, use agent_browser_get_text or agent_browser_find instead of reading the whole page.";

type Tool = { inputSchema?: { properties?: Record<string, unknown>; required?: unknown } & Record<string, unknown> } & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function slimBrowserToolList(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.tools)) return result;
  const tools = (result.tools as unknown[]).map((tool) => {
    if (!isRecord(tool) || !isRecord(tool.inputSchema)) return tool;
    const schema = tool.inputSchema as NonNullable<Tool["inputSchema"]>;
    const properties = isRecord(schema.properties)
      ? Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !HARNESS_OWNED_BROWSER_PARAMS.has(name)))
      : schema.properties;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name) => typeof name !== "string" || !HARNESS_OWNED_BROWSER_PARAMS.has(name))
      : schema.required;
    return { ...tool, inputSchema: { ...schema, ...(properties === undefined ? {} : { properties }), ...(required === undefined ? {} : { required }) } };
  });
  return { ...result, tools };
}

export function stripHarnessOwnedArguments(params: unknown): unknown {
  if (!isRecord(params) || !isRecord(params.arguments)) return params;
  const kept = Object.entries(params.arguments).filter(([name]) => !HARNESS_OWNED_BROWSER_PARAMS.has(name));
  return kept.length === Object.keys(params.arguments).length ? params : { ...params, arguments: Object.fromEntries(kept) };
}

export function shapeBrowserToolResult(result: unknown, options: { toolName?: string; budget?: number } = {}): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const budget = options.budget ?? DEFAULT_BROWSER_RESULT_BUDGET;
  let textParts = 0;
  const content = (result.content as unknown[]).map((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part;
    textParts++;
    const outcome = trimResultText({ text: part.text, budget, toolName: options.toolName });
    return outcome.trimmed ? { ...part, text: outcome.text + BROWSER_NARROWING_HINT } : part;
  });
  if (!textParts) return { ...result, content };
  return { ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== "structuredContent")), content };
}
