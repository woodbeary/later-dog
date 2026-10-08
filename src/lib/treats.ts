// Treats: a tap that says "good dog". It changes nothing about how a dog works — it only makes the dog happy for a
// moment and keeps a count on its profile. The count lives in this browser's storage (it is a feeling, not data), and
// every read and write survives a storage that is blocked or full.

const KEY = (botId: string) => `laterdog.treats.${botId}`;
const listeners = new Set<() => void>();

export function treatCount(botId: string): number {
  try {
    const value = Number.parseInt(globalThis.localStorage?.getItem(KEY(botId)) ?? "0", 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Adds one treat and returns the new count (the in-memory answer when storage is unavailable). */
export function giveTreat(botId: string): number {
  const next = treatCount(botId) + 1;
  try {
    globalThis.localStorage?.setItem(KEY(botId), String(next));
  } catch {
    // a private window or a full store: the dog is still happy
  }
  for (const listener of listeners) listener();
  return next;
}

/** Re-render when any dog gets a treat (the profile card's count). */
export function onTreat(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
