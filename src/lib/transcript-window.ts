export const TRANSCRIPT_WINDOW_SIZE = 120;

export interface TranscriptWindow<T> {
  visible: T[];
  hiddenCount: number;
  laterCount: number;
  startIndex: number;
  endIndex: number;
}

export interface TranscriptWindowRange {
  start: number;
  end: number;
}

export function tailWindowStart(total: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, total - size);
}

export type CountsInWindow<T> = (message: T) => boolean;

export function windowStartBefore<T>(
  messages: readonly T[],
  from: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  counts?: CountsInWindow<T>,
): number {
  if (!counts) return expandWindowStart(from, size);
  let seen = 0;
  for (let index = Math.min(from, messages.length) - 1; index >= 0; index--) {
    if (counts(messages[index]!) && ++seen >= size) return index;
  }
  return 0;
}

export function windowEndAfter<T>(
  messages: readonly T[],
  from: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  counts?: CountsInWindow<T>,
): number {
  if (!counts) return Math.min(messages.length, from + size);
  let seen = 0;
  for (let index = Math.max(0, from); index < messages.length; index++) {
    if (counts(messages[index]!) && ++seen >= size) return index + 1;
  }
  return messages.length;
}

function countedBetween<T>(messages: readonly T[], from: number, to: number, counts?: CountsInWindow<T>): number {
  if (!counts) return Math.max(0, to - from);
  let seen = 0;
  for (let index = Math.max(0, from); index < to; index++) if (counts(messages[index]!)) seen += 1;
  return seen;
}

export function followWindowStart<T extends { role?: string }>(
  messages: readonly T[],
  start: number,
  counts?: CountsInWindow<T>,
): number {
  const tail = windowStartBefore(messages, messages.length, TRANSCRIPT_WINDOW_SIZE, counts);
  const oldest = Math.max(start, windowStartBefore(messages, messages.length, TRANSCRIPT_WINDOW_SIZE * 2, counts));
  for (let index = messages.length - 1; index >= oldest; index--) {
    if (messages[index].role === "user") return Math.min(tail, index);
  }
  return tail;
}

export function expandWindowStart(startIndex: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, startIndex - size);
}

export function focusWindowRange(
  total: number,
  targetIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
): TranscriptWindowRange {
  const safeTotal = Math.max(0, total);
  const safeSize = Math.max(1, size);
  const target = Math.max(0, Math.min(targetIndex, Math.max(0, safeTotal - 1)));
  const start = Math.max(0, Math.min(target - Math.floor(safeSize / 2), Math.max(0, safeTotal - safeSize)));
  return { start, end: Math.min(safeTotal, start + safeSize) };
}

export function resolveTranscriptWindow<T>(
  messages: readonly T[],
  startIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  endIndex: number | null = null,
  counts?: CountsInWindow<T>,
): TranscriptWindow<T> {
  const requestedEnd = endIndex === null ? messages.length : Math.max(0, Math.min(messages.length, endIndex));
  const invalidFiniteWindow = endIndex !== null && startIndex >= requestedEnd;
  const start =
    startIndex >= messages.length || invalidFiniteWindow
      ? windowStartBefore(messages, messages.length, size, counts)
      : Math.max(0, startIndex);
  const end = invalidFiniteWindow ? messages.length : Math.max(start, requestedEnd);
  return {
    visible: messages.slice(start, end),
    hiddenCount: countedBetween(messages, 0, start, counts),
    laterCount: countedBetween(messages, end, messages.length, counts),
    startIndex: start,
    endIndex: end,
  };
}
