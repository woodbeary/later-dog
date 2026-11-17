import { useSyncExternalStore } from "react";

export type Composed = { message: string } | { kept: true } | null;

export interface TypedAnswer {
  threadId: string;
  messageId: string;
  requestId: string;
  compose: (text: string) => Composed;
  limit?: number;
  sent?: (answer: string) => void;
  failed?: () => void;
}

export type TypedAnswerSend = (target: { threadId: string; requestId: string; message: string; onError: () => void }) => void;

let current: TypedAnswer | null = null;
const closed = new Set<string>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

function publish(next: TypedAnswer | null): void {
  if (next === current) return;
  current = next;
  if (next) closed.delete(next.threadId);
  changed();
}

export function chooseTypedAnswer(answer: TypedAnswer): void {
  publish(answer);
}

export function releaseTypedAnswer(messageId?: string, answered = false): void {
  if (!current || (messageId !== undefined && current.messageId !== messageId)) return;
  const threadId = current.threadId;
  current = null;
  if (answered) closed.add(threadId);
  changed();
}

export function forgetClosedAnswer(threadId: string): void {
  if (closed.delete(threadId)) changed();
}

export function typedAnswerFor(threadId: string | undefined): TypedAnswer | null {
  return current && threadId && current.threadId === threadId ? current : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function answerTooLong(target: TypedAnswer | null, text: string): boolean {
  return target?.limit !== undefined && text.trim().length > target.limit;
}

export function useTypedAnswer(threadId: string | undefined): TypedAnswer | null {
  return useSyncExternalStore(subscribe, () => typedAnswerFor(threadId), () => null);
}

export function useClosedAnswer(threadId: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => Boolean(threadId && closed.has(threadId)), () => false);
}

export type TypedAnswerResult = "sent" | "kept" | "waiting" | "too-long" | null;

export function answerByTyping(threadId: string | undefined, text: string, send: TypedAnswerSend, restore: () => void): TypedAnswerResult {
  const target = typedAnswerFor(threadId);
  if (!target || !text.trim()) return null;
  if (answerTooLong(target, text)) return "too-long";
  const composed = target.compose(text.trim());
  if (!composed) return "waiting";
  if ("kept" in composed) return "kept";
  publish(null);
  target.sent?.(composed.message);
  send({
    threadId: target.threadId,
    requestId: target.requestId,
    message: composed.message,
    onError: () => {
      target.failed?.();
      publish(target);
      restore();
    },
  });
  return "sent";
}
