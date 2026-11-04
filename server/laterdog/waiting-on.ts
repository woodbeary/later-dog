import type { WireWaitingOn } from "../../shared/wire.ts";

export function waitingOn(outstanding: readonly { botId: string; threadId?: string; status?: string }[], nameOf: (botId: string) => string | undefined): WireWaitingOn[] {
  const named = new Map<string, WireWaitingOn>();
  for (const { botId, threadId, status } of outstanding) {
    const name = nameOf(botId)?.trim();
    if (!name) continue;
    const running = status === "running";
    const known = named.get(botId);
    if (known && (known.state === "running" || !running)) continue;
    named.set(botId, { botId, name, ...(threadId ? { threadId } : {}), state: running ? "running" : "queued" });
  }
  return [...named.values()];
}
