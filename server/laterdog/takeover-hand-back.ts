import { isOpenTakeover, type TakeoverRequestCardData } from "../../shared/takeover.ts";
import type { TakeoverWait } from "./takeover.ts";

export const HAND_BACK_ACTION = "hand-back";

export interface ThreadCards {
  threadId: string;
  messages: ReadonlyArray<{ id: string; kind?: string; from?: { botId?: string }; card?: { takeoverRequest?: TakeoverRequestCardData } }>;
}

export function heldTakeoverCards(botId: string, threads: readonly ThreadCards[]): TakeoverWait[] {
  const found: TakeoverWait[] = [];
  for (const thread of threads) {
    for (const message of thread.messages) {
      const request = message.kind === "options" ? message.card?.takeoverRequest : undefined;
      if (request?.status !== "in-control") continue;
      if (message.from?.botId && message.from.botId !== botId) continue;
      found.push({ botId, threadId: thread.threadId, messageId: message.id });
    }
  }
  return found;
}

export function takeoversToHandBack(registered: readonly TakeoverWait[], found: readonly TakeoverWait[], read: (wait: TakeoverWait) => TakeoverRequestCardData | null): TakeoverWait[] {
  const seen = new Set<string>();
  const ending: TakeoverWait[] = [];
  for (const wait of [...registered, ...found]) {
    const key = `${wait.threadId}:${wait.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const card = read(wait);
    if (card && isOpenTakeover(card.status)) ending.push(wait);
  }
  return ending;
}
