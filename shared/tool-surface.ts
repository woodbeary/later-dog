
export const SCREEN_TOUCHING_TOOLS: ReadonlySet<string> = new Set([
  "screenshot", "click", "type_text", "press_key", "key_press", "scroll", "computer_batch", "open_url", "browser_click", "browser_fill",
  "browser_navigate", "browser_type", "browser_press", "browser_scroll", "browser_hover", "browser_drag",
  "browser_select_option", "browser_back", "browser_forward", "browser_screenshot",
  "agent_browser_open", "agent_browser_click", "agent_browser_fill", "agent_browser_type", "agent_browser_press",
  "agent_browser_select", "agent_browser_check", "agent_browser_screenshot",
  "double_click", "right_click", "drag", "hotkey", "move_cursor", "launch_app", "bring_to_front", "zoom",
]);

export const TOOL_NAMESPACE = /^(?:mcp__.+?|[a-z][a-z0-9_-]{0,31})__/;

export function screenTouchingTool(toolName: string): boolean {
  const bare = toolName.toLowerCase().replace(TOOL_NAMESPACE, "");
  return SCREEN_TOUCHING_TOOLS.has(bare) || SCREEN_TOUCHING_TOOLS.has(bare.replace(/^(?:computer|browser)_/, ""));
}

export function screenSurfaceForTool(toolName: string): "browser" | "computer" {
  const name = toolName.toLowerCase();
  if (name.startsWith("mcp__computer__") || name.startsWith("computer_")) return "computer";
  if (name.startsWith("mcp__browser__") || name.startsWith("browser__")) return "browser";
  const bare = name.replace(TOOL_NAMESPACE, "");
  if (bare === "browser_click" || bare === "browser_fill") return "computer";
  return bare.startsWith("agent_browser_") || bare.startsWith("browser_") ? "browser" : "computer";
}

export function toolSurfaceKind(toolName: string): "browser" | "computer" | null {
  const name = toolName.toLowerCase();
  if (name.startsWith("mcp__browser__") || name.startsWith("browser__")) return "browser";
  if (name.startsWith("mcp__computer__") || name.startsWith("computer__") || name.startsWith("computer_")) return "computer";
  const bare = name.replace(TOOL_NAMESPACE, "");
  if (bare === "browser_click" || bare === "browser_fill") return "computer";
  if (bare.startsWith("agent_browser_") || bare.startsWith("browser_")) return "browser";
  return SCREEN_TOUCHING_TOOLS.has(bare) ? "computer" : null;
}
