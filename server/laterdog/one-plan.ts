import { allowsTool } from "../../shared/tool-scope.ts";

export const ENGINE_PLAN_TOOLS = ["TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"] as const;

export function hasSetPlan(mcpServers: Readonly<Record<string, unknown>>, toolScope: unknown): boolean {
  return Object.hasOwn(mcpServers, "agents") && allowsTool(toolScope, { kind: "mcp", server: "agents", name: "set_plan" });
}

export function disallowedWithOnePlan(configured: readonly string[] | undefined, hasSetPlan: boolean): string[] {
  const listed = [...(configured ?? [])];
  if (!hasSetPlan) return listed;
  return [...listed, ...ENGINE_PLAN_TOOLS.filter((tool) => !listed.includes(tool))];
}
