// Whether the voice button shows beside the message field: off until the
// person turns voice mode on in Settings, remembered on this device.
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
  } catch {
    // Private windows may refuse storage; the choice still holds this session.
  }
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
