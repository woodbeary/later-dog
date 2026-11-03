import type { WireWaitingOn } from "../../shared/wire.ts";

export function waitingOn(outstanding: readonly { botId: string }[], nameOf: (botId: string) => string | undefined): WireWaitingOn[] {
  const named = new Map<string, string>();
  for (const { botId } of outstanding) {
    const name = nameOf(botId)?.trim();
    if (name && !named.has(botId)) named.set(botId, name);
  }
  return [...named].map(([botId, name]) => ({ botId, name }));
}
