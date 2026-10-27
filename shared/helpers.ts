export type HelperState = "running" | "done" | "failed" | "stopped";

export interface HelperMember {
  id: string;
  label: string;
  state: HelperState;
  phase?: string;
  activity?: string;
  recentActivity?: string[];
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
}

export interface HelperStep {
  tool: string;
  summary?: string;
}

export interface Helper {
  id: string;
  toolUseId?: string;
  steps?: HelperStep[];
  kind: "agent" | "workflow";
  label: string;
  state: HelperState;
  background: boolean;
  startedAt: number;
  endedAt?: number;
  activity?: string;
  recentActivity?: string[];
  summary?: string;
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
  members?: HelperMember[];
}

export interface HelpersSnapshot {
  helpers: Record<string, Helper[]>;
}

export const HELPER_LIMIT = 24;

export function helperRunning(helper: Pick<Helper, "state">): boolean {
  return helper.state === "running";
}

export function applyHelperUpdate(helpers: Helper[], next: Helper): Helper[] {
  const index = helpers.findIndex((helper) => helper.id === next.id);
  if (index !== -1 && !helperRunning(helpers[index]!) && helperRunning(next)) return helpers;
  const merged = index === -1 ? [...helpers, next] : helpers.map((helper, at) => (at === index ? next : helper));
  const overflow = merged.length - HELPER_LIMIT;
  if (overflow <= 0) return merged;
  const dropped = new Set(merged.filter((helper) => !helperRunning(helper)).slice(0, overflow).map((helper) => helper.id));
  return merged.filter((helper) => !dropped.has(helper.id));
}

export function withoutSettledHelpers(helpers: Helper[]): Helper[] {
  return helpers.every(helperRunning) ? helpers : helpers.filter(helperRunning);
}
