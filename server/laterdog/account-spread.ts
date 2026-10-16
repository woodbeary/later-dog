export interface SpreadCandidate {
  instanceId: string;
  own: boolean;
  running: number;
  left?: number;
  index: number;
}

export function leastLoaded(candidates: readonly SpreadCandidate[]): string | undefined {
  return [...candidates].sort((a, b) =>
    a.running - b.running ||
    Number(b.own) - Number(a.own) ||
    Number(a.left === undefined) - Number(b.left === undefined) ||
    (b.left ?? 0) - (a.left ?? 0) ||
    a.index - b.index)[0]?.instanceId;
}

export function homeAccount(order: readonly string[], defaultAccount: string | undefined): string | undefined {
  return defaultAccount !== undefined && order.includes(defaultAccount) ? defaultAccount : order[0];
}

export function runningByAccount(...lists: Iterable<readonly [threadId: string, instanceId: string]>[]): Record<string, number> {
  const seen = new Set<string>();
  const running: Record<string, number> = {};
  for (const list of lists) {
    for (const [threadId, instanceId] of list) {
      if (seen.has(threadId)) continue;
      seen.add(threadId);
      running[instanceId] = (running[instanceId] ?? 0) + 1;
    }
  }
  return running;
}
