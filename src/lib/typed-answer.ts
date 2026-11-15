import { useSyncExternalStore } from "react";

export interface TypedAnswer {
  threadId: string;
  messageId: string;
  requestId: string;
  compose: (text: string) => string | null;
  sent?: (answer: string) => void;
  failed?: () => void;
}

export type TypedAnswerSend = (target: { threadId: string; requestId: string; message: string; onError: () => void }) => void;

let current: TypedAnswer | null = null;
const listeners = new Set<() => void>();

function publish(next: TypedAnswer | null): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function chooseTypedAnswer(answer: TypedAnswer): void {
  publish(answer);
}

export function releaseTypedAnswer(messageId?: string): void {
  if (!current || (messageId !== undefined && current.messageId !== messageId)) return;
  publish(null);
}

export function typedAnswerFor(threadId: string | undefined): TypedAnswer | null {
  return current && threadId && current.threadId === threadId ? current : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTypedAnswer(threadId: string | undefined): TypedAnswer | null {
  return useSyncExternalStore(subscribe, () => typedAnswerFor(threadId), () => null);
}

export type TypedAnswerResult = "sent" | "waiting" | null;

export function answerByTyping(threadId: string | undefined, text: string, send: TypedAnswerSend, restore: () => void): TypedAnswerResult {
  const target = typedAnswerFor(threadId);
  if (!target || !text.trim()) return null;
  const message = target.compose(text.trim());
  if (!message) return "waiting";
  publish(null);
  target.sent?.(message);
  send({
    threadId: target.threadId,
    requestId: target.requestId,
    message,
    onError: () => {
      target.failed?.();
      publish(target);
      restore();
    },
  });
  return "sent";
}
