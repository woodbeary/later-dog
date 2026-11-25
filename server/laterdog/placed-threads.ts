export interface PlacedThreads {
  place(threadId: string): () => void;
  has(threadId: string): boolean;
}

export function createPlacedThreads(): PlacedThreads {
  const engines = new Map<string, Set<symbol>>();
  return {
    place(threadId) {
      const engine = Symbol(threadId);
      const held = engines.get(threadId) ?? new Set<symbol>();
      held.add(engine);
      engines.set(threadId, held);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = engines.get(threadId);
        current?.delete(engine);
        if (current && !current.size) engines.delete(threadId);
      };
    },
    has(threadId) {
      return engines.has(threadId);
    },
  };
}

export const placedThreads = createPlacedThreads();

export interface PreToolGuards<T> {
  signal: () => T | null;
  homeDisk: () => T | null;
  homeHeavy: () => T | null;
  alwaysAsk: () => T | null;
}

export function preToolGuardDecision<T>(threadId: string, guards: PreToolGuards<T>, placed: PlacedThreads = placedThreads): T | null {
  const onHome = !placed.has(threadId);
  return guards.signal() ?? (onHome ? guards.homeDisk() ?? guards.homeHeavy() : null) ?? guards.alwaysAsk();
}
