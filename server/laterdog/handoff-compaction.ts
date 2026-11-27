export const HANDOFF_COMPACTION_PERCENT = 10;
export const SMALLEST_HANDOFF_WINDOW = 100_000;
export const HANDOFF_WINDOW_SHARE = 0.9;
export const HANDOFF_COMPACTION_REPEAT_MS = 5 * 60 * 60 * 1000;

export interface HandoffCompactionFacts {
  driverKind: string;
  instanceId: string;
  left: number | undefined;
  nextDriverKind: string | undefined;
  contextTokens: number | undefined;
}

export function handoffCompactWindow(facts: HandoffCompactionFacts): number | undefined {
  if (facts.driverKind !== "claudeAgent") return undefined;
  if (facts.left === undefined || facts.left >= HANDOFF_COMPACTION_PERCENT) return undefined;
  if (!facts.nextDriverKind || facts.nextDriverKind === facts.driverKind) return undefined;
  if (!facts.contextTokens || facts.contextTokens <= SMALLEST_HANDOFF_WINDOW) return undefined;
  return Math.max(SMALLEST_HANDOFF_WINDOW, Math.floor(facts.contextTokens * HANDOFF_WINDOW_SHARE));
}

export class HandoffCompactions {
  private readonly asked = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  window(threadId: string, facts: HandoffCompactionFacts): number | undefined {
    const window = handoffCompactWindow(facts);
    if (window === undefined) return undefined;
    for (const [key, at] of this.asked) if (this.now() - at >= HANDOFF_COMPACTION_REPEAT_MS) this.asked.delete(key);
    const key = `${threadId}\n${facts.instanceId}`;
    const at = this.asked.get(key);
    if (at !== undefined && this.now() - at < HANDOFF_COMPACTION_REPEAT_MS) return undefined;
    this.asked.set(key, this.now());
    return window;
  }
}
