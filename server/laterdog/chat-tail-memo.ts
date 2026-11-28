import type { StoreChange } from "../store.ts";

export interface ChatTailMemo<T> {
  get(threadId: string): T;
  changed(change: StoreChange): void;
}

export function chatTailMemo<T>(compute: (threadId: string) => T): ChatTailMemo<T> {
  const known = new Map<string, T>();
  return {
    get(threadId) {
      if (known.has(threadId)) return known.get(threadId)!;
      const value = compute(threadId);
      known.set(threadId, value);
      return value;
    },
    changed(change) {
      if ("threadId" in change) known.delete(change.threadId);
    },
  };
}
