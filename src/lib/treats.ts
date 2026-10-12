
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

export function giveTreat(botId: string): number {
  const next = treatCount(botId) + 1;
  try {
    globalThis.localStorage?.setItem(KEY(botId), String(next));
  } catch {}
  for (const listener of listeners) listener();
  return next;
}

export function onTreat(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
