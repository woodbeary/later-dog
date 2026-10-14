export const HANDOFF_IDLE_MS = 20 * 60_000;
export const HANDOFF_HARD_CAP_MS = 4 * 60 * 60_000;

export const HANDOFF_ENDS = ["person", "interrupted", "deleted", "idle", "capped", "origin", "limit", "restart", "problem"] as const;
export type HandoffEnd = (typeof HANDOFF_ENDS)[number];

export const TIME_ENDS: readonly HandoffEnd[] = ["idle", "capped"];

export function endedForTime(end: HandoffEnd | undefined): boolean {
  return end !== undefined && TIME_ENDS.includes(end);
}

export interface HandoffBudgetLimits {
  idleMs: number;
  hardCapMs: number;
  minRunwayMs: number;
}

export interface HandoffActivity {
  at?: number;
  waiting?: boolean;
}

export interface BudgetRoot {
  id: string;
  createdAt: number;
  lastProgressAt?: number;
}

export function plainDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes >= 90) {
    const hours = Math.round(minutes / 6) / 10;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (minutes >= 60) return "1 hour";
  if (minutes < 1) return "under a minute";
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export function endWords(end: HandoffEnd, limits: Pick<HandoffBudgetLimits, "idleMs" | "hardCapMs">, unstarted = false): string {
  switch (end) {
    case "person": return unstarted ? "The person stopped this before it started." : "The person stopped this work.";
    case "interrupted": return unstarted ? "Interrupted before it started." : "Interrupted before it finished.";
    case "deleted": return "The conversation that asked for this was deleted.";
    case "idle": return `Nothing moved for ${plainDuration(limits.idleMs)}, so later.dog stopped waiting.`;
    case "capped": return `Ran out of time after ${plainDuration(limits.hardCapMs)}.`;
    case "origin": return "The request that started this ended before it could begin.";
    case "limit": return "Too many teammate requests in one go.";
    case "restart": return "later.dog restarted while this was running, so it was not picked up again.";
    case "problem": return "Something changed, so this could not go on.";
  }
}

export function continueOffer(end: HandoffEnd, limits: Pick<HandoffBudgetLimits, "idleMs" | "hardCapMs">): string {
  const words = end === "capped"
    ? `Ran out of time after ${plainDuration(limits.hardCapMs)}.`
    : `Nothing moved for ${plainDuration(limits.idleMs)}.`;
  return `${words} Continue?`;
}

export function teammateEndLabel(name: string, status: string, end: HandoffEnd | undefined): string {
  if (status === "completed") return `${name} replied`;
  if (end === undefined) return status === "cancelled" ? `${name} stopped` : `${name} couldn't finish`;
  if (end === "person") return `${name} stopped`;
  if (endedForTime(end)) return `${name} ran out of time`;
  if (end === "origin") return `${name} never got started`;
  if (end === "interrupted") return `${name} was interrupted`;
  return `${name} couldn't finish`;
}

export class HandoffBudget {
  private readonly lastAlive = new Map<string, number>();
  private readonly limits: HandoffBudgetLimits;
  private readonly now: () => number;

  constructor(limits: HandoffBudgetLimits, now: () => number) {
    this.limits = limits;
    this.now = now;
  }

  note(rootId: string, at: number): void {
    this.lastAlive.set(rootId, Math.max(this.lastAlive.get(rootId) ?? 0, at));
  }

  forget(rootId: string): void {
    this.lastAlive.delete(rootId);
  }

  runningProgressAt(activity: HandoffActivity | undefined, startedAt: number): number {
    if (!activity || activity.waiting) return this.now();
    return Math.max(activity.at ?? 0, startedAt);
  }

  idleFor(root: BudgetRoot): number {
    const last = Math.max(root.lastProgressAt ?? root.createdAt, this.lastAlive.get(root.id) ?? 0);
    return Math.max(0, this.now() - last);
  }

  idle(root: BudgetRoot): boolean {
    return this.idleFor(root) > this.limits.idleMs;
  }

  hardCapAt(root: BudgetRoot): number {
    return root.createdAt + this.limits.hardCapMs;
  }

  remaining(root: BudgetRoot): number {
    return this.hardCapAt(root) - this.now();
  }

  pastHardCap(root: BudgetRoot): boolean {
    return this.now() >= this.hardCapAt(root);
  }

  hasRunway(root: BudgetRoot): boolean {
    return this.remaining(root) >= this.limits.minRunwayMs;
  }

  refusal(root: BudgetRoot): string {
    const left = plainDuration(Math.max(this.remaining(root), 0));
    return `Time is nearly up for this team task: ${left} left of ${plainDuration(this.limits.hardCapMs)}, so no new teammate work can start. Finish with what you have and tell the person plainly that time ran out.`;
  }
}
