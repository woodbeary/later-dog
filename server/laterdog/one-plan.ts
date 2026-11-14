export const ENGINE_PLAN_TOOLS = ["TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"] as const;

export function disallowedWithOnePlan(configured: readonly string[] | undefined, hasSetPlan: boolean): string[] {
  const listed = [...(configured ?? [])];
  if (!hasSetPlan) return listed;
  return [...listed, ...ENGINE_PLAN_TOOLS.filter((tool) => !listed.includes(tool))];
}
