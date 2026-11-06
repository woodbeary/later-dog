import type { WireWaitingOn } from "../../shared/wire.ts";

export interface AwaitedNode {
  botId: string;
  threadId?: string;
  status?: string;
}

export function waitingOn(
  outstanding: readonly AwaitedNode[],
  nameOf: (botId: string) => string | undefined,
  askOf: (node: AwaitedNode) => string | null = () => null,
): WireWaitingOn[] {
  const rank = { needsYou: 2, running: 1, queued: 0 } as const;
  const named = new Map<string, WireWaitingOn>();
  for (const node of outstanding) {
    const name = nameOf(node.botId)?.trim();
    if (!name) continue;
    const ask = node.status === "running" ? null : askOf(node);
    const state = ask ? "needsYou" : node.status === "running" ? "running" : "queued";
    const known = named.get(node.botId);
    if (known && rank[known.state ?? "queued"] >= rank[state]) continue;
    named.set(node.botId, { botId: node.botId, name, ...(node.threadId ? { threadId: node.threadId } : {}), state, ...(ask ? { ask } : {}) });
  }
  return [...named.values()];
}
