export interface EarlySnapshot<T> {
  claim(): Promise<T | null>;
  abandon(): void;
}

export function earlySnapshot<T>(take: () => Promise<T | null>, release: (value: T) => void): EarlySnapshot<T> {
  const pending = take().catch(() => null);
  let settled = false;
  return {
    claim() {
      settled = true;
      return pending;
    },
    abandon() {
      if (settled) return;
      settled = true;
      void pending.then((value) => { if (value) release(value); });
    },
  };
}

export function createTurnPhases(options: { log: (line: string) => void; now?: () => number; name?: string }) {
  const now = options.now ?? Date.now;
  const turns = new Map<string, { last: number; parts: string[] }>();
  return {
    begin(threadId: string): void {
      turns.set(threadId, { last: now(), parts: [] });
      if (turns.size > 200) turns.delete(turns.keys().next().value!);
    },
    mark(threadId: string, phase: string): void {
      const turn = turns.get(threadId);
      if (!turn) return;
      const at = now();
      turn.parts.push(`${phase} ${((at - turn.last) / 1000).toFixed(1)} s`);
      turn.last = at;
    },
    end(threadId: string, phase: string): void {
      this.mark(threadId, phase);
      const turn = turns.get(threadId);
      turns.delete(threadId);
      if (turn) options.log(`${options.name ?? "turn phases"} ${threadId.slice(0, 8)}: ${turn.parts.join(", ")}`);
    },
  };
}
