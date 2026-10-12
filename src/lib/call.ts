import { useSyncExternalStore } from "react";

import { speaker } from "./tts";

let current: string | null = null;
const watchers = new Set<() => void>();

function notify() {
  for (const fn of Array.from(watchers)) fn();
}

export function currentCall(): string | null {
  return current;
}

export function startCall(targetId: string) {
  if (current === targetId) return;
  speaker.stop();
  void window.laterdog?.speechStop?.();
  current = targetId;
  notify();
}

export function endCall(targetId?: string): boolean {
  if (targetId && current !== targetId) return false;
  if (current === null) return false;
  current = null;
  speaker.stop();
  void window.laterdog?.speechStop?.();
  notify();
  return true;
}

export function deferCallCleanup(targetId: string, isMounted: () => boolean): void {
  queueMicrotask(() => {
    if (!isMounted()) endCall(targetId);
  });
}

export function useOnCall(): string | null {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => current,
    () => current,
  );
}
