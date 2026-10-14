import { useSyncExternalStore } from "react";

export const SHOW_EVERY_UPDATE_KEY = "laterdog-show-every-update";

type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

const listeners = new Set<() => void>();
let sessionChoice: boolean | undefined;

function storage(): Store {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readShowEveryUpdate(store: Store = storage()): boolean {
  try {
    return store?.getItem(SHOW_EVERY_UPDATE_KEY) === "1";
  } catch {
    return false;
  }
}

export function showEveryUpdate(): boolean {
  return sessionChoice ?? readShowEveryUpdate();
}

function notify(): void {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key === SHOW_EVERY_UPDATE_KEY || event.key === null) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function setShowEveryUpdate(on: boolean, store: Store = storage()): void {
  sessionChoice = on;
  try {
    store?.setItem(SHOW_EVERY_UPDATE_KEY, on ? "1" : "0");
    if (readShowEveryUpdate(store) === on) sessionChoice = undefined;
  } catch {}
  notify();
}

export function useShowEveryUpdate(): boolean {
  return useSyncExternalStore(subscribe, showEveryUpdate, () => false);
}
