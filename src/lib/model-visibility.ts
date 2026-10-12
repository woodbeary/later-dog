import { useSyncExternalStore } from "react";

export const HIDDEN_MODELS_KEY = "laterdog.hiddenModels.v1";
const key = (instanceId: string, model: string) => `${instanceId}\u0000${model}`;

function readStored(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(HIDDEN_MODELS_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

let hidden: ReadonlySet<string> = readStored();
const watchers = new Set<() => void>();

export function modelShown(instanceId: string, model: string, set: ReadonlySet<string> = hidden): boolean {
  return !set.has(key(instanceId, model));
}

export function setModelShown(instanceId: string, model: string, shown: boolean): void {
  const next = new Set(hidden);
  if (shown) next.delete(key(instanceId, model));
  else next.add(key(instanceId, model));
  hidden = next;
  try {
    globalThis.localStorage?.setItem(HIDDEN_MODELS_KEY, JSON.stringify([...next]));
  } catch {}
  for (const fn of Array.from(watchers)) fn();
}

export function useHiddenModels(): ReadonlySet<string> {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => hidden,
    () => hidden,
  );
}
