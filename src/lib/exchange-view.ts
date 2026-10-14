import { useSyncExternalStore } from "react";

let openGroupId: string | null = null;
const listeners = new Set<() => void>();

function publish(next: string | null): void {
  if (next === openGroupId) return;
  openGroupId = next;
  for (const listener of listeners) listener();
}

export const openExchange = (groupId: string): void => publish(groupId);
export const closeExchange = (): void => publish(null);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useOpenExchange(): string | null {
  return useSyncExternalStore(subscribe, () => openGroupId, () => null);
}
