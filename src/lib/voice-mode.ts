import { useSyncExternalStore } from "react";

export const VOICE_MODE_KEY = "laterdog.voiceMode.v1";

function readStored(): boolean {
  try {
    return globalThis.localStorage?.getItem(VOICE_MODE_KEY) === "on";
  } catch {
    return false;
  }
}

let current = readStored();
const watchers = new Set<() => void>();

export function voiceMode(): boolean {
  return current;
}

export function setVoiceMode(on: boolean): void {
  if (on === current) return;
  current = on;
  try {
    globalThis.localStorage?.setItem(VOICE_MODE_KEY, on ? "on" : "off");
  } catch {}
  for (const fn of Array.from(watchers)) fn();
}

export function useVoiceMode(): boolean {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => current,
    () => current,
  );
}
