import { useSyncExternalStore } from "react";
import type { RuntimeEvent } from "../../shared/runtime-events";

export const REASONING_TAIL_CHARS = 4_000;
const THREAD_LIMIT = 24;
const WORD_EDGE_CHARS = 40;

export interface TurnReasoning {
  turnId: string | null;
  text: string;
  clipped: boolean;
  streamed: boolean;
  tokens: number | null;
  blockTokens: number;
  earlierTokens: number;
}

export const NO_REASONING: TurnReasoning = {
  turnId: null,
  text: "",
  clipped: false,
  streamed: false,
  tokens: null,
  blockTokens: 0,
  earlierTokens: 0,
};

function forTurn(current: TurnReasoning | undefined, turnId: string | undefined): TurnReasoning {
  if (!current) return { ...NO_REASONING, turnId: turnId ?? null };
  if (turnId && current.turnId && current.turnId !== turnId) return { ...NO_REASONING, turnId };
  return turnId && !current.turnId ? { ...current, turnId } : current;
}

function tail(text: string): string {
  const cut = text.slice(-REASONING_TAIL_CHARS);
  const edge = cut.search(/\s/);
  return edge > 0 && edge < WORD_EDGE_CHARS ? cut.slice(edge + 1) : cut;
}

export function withReasoningEvent(current: TurnReasoning | undefined, event: RuntimeEvent): TurnReasoning | undefined {
  if (event.type === "turn.started") return { ...NO_REASONING, turnId: event.turnId ?? null };
  if (event.type === "turn.completed") return undefined;
  if (event.type === "content.delta" && event.streamKind === "reasoning_text") {
    if (!event.delta) return current;
    const base = forTurn(current, event.turnId);
    const joined = base.text + event.delta;
    const clipped = base.clipped || joined.length > REASONING_TAIL_CHARS;
    const text = joined.length > REASONING_TAIL_CHARS ? tail(joined) : joined;
    return { ...base, text, clipped, streamed: base.streamed || /\S/.test(text) };
  }
  if (event.type === "item.updated" && event.itemType === "reasoning" && typeof event.tokens === "number" && Number.isFinite(event.tokens)) {
    const base = forTurn(current, event.turnId);
    const reading = Math.max(0, Math.round(event.tokens));
    const newBlock = reading < base.blockTokens;
    const earlierTokens = newBlock ? base.earlierTokens + base.blockTokens : base.earlierTokens;
    return { ...base, blockTokens: reading, earlierTokens, tokens: earlierTokens + reading };
  }
  return current;
}

const reasoning = new Map<string, TurnReasoning>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function receiveReasoningEvent(event: RuntimeEvent): void {
  if (!event.threadId) return;
  const before = reasoning.get(event.threadId);
  const after = withReasoningEvent(before, event);
  if (after === before) return;
  if (after) {
    reasoning.delete(event.threadId);
    reasoning.set(event.threadId, after);
    while (reasoning.size > THREAD_LIMIT) reasoning.delete(reasoning.keys().next().value!);
  } else {
    reasoning.delete(event.threadId);
  }
  for (const listener of listeners) listener();
}

export function turnReasoning(threadId: string | null | undefined): TurnReasoning {
  return (threadId && reasoning.get(threadId)) || NO_REASONING;
}

export function forgetReasoning(): void {
  reasoning.clear();
  for (const listener of listeners) listener();
}

export function useTurnReasoning(threadId: string | null | undefined): TurnReasoning {
  return useSyncExternalStore(subscribe, () => turnReasoning(threadId), () => NO_REASONING);
}
