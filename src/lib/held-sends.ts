import { readOutboxCard, type OutboxCard } from "./outbox";

export const HELD_SENDS_KEY = "laterdog-held-sends";
export const HELD_GIVE_UP_MS = 65 * 60 * 1000;
export const HELD_ASK_MAX = 50;
export const HELD_ASK_FIRST_MS = 30_000;
export const HELD_ASK_CAP_MS = 5 * 60_000;
export const HELD_NOT_SENT = "Your home never took this message, so it was not sent. It is kept below to send again.";

export interface HeldSend {
  sendId: string;
  threadId: string;
  draftId: string;
  text: string;
  requestText: string;
  replyToId?: string;
  card?: OutboxCard;
  at: number;
}

export interface HeldAnswer {
  held: ReadonlySet<string>;
  dropped: ReadonlySet<string>;
}

type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function heldSend(value: unknown): HeldSend | null {
  if (typeof value !== "object" || value === null) return null;
  const { sendId, threadId, draftId, text, requestText, replyToId, at, card } = value as Record<string, unknown>;
  if (typeof sendId !== "string" || typeof threadId !== "string" || typeof draftId !== "string" || typeof text !== "string" || typeof requestText !== "string" || typeof at !== "number") return null;
  const cardRef = readOutboxCard(card);
  return { sendId, threadId, draftId, text, requestText, at, ...(typeof replyToId === "string" ? { replyToId } : {}), ...(cardRef ? { card: cardRef } : {}) };
}

export function readHeldSends(store: KeyValueStore): HeldSend[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(HELD_SENDS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.flatMap((entry) => heldSend(entry) ?? []) : [];
  } catch {
    return [];
  }
}

export function writeHeldSends(store: KeyValueStore, sends: readonly HeldSend[]): void {
  try {
    if (sends.length === 0) store?.removeItem(HELD_SENDS_KEY);
    else store?.setItem(HELD_SENDS_KEY, JSON.stringify(sends));
  } catch {}
}

export function heldAnswer(body: unknown): HeldAnswer | null {
  if (typeof body !== "object" || body === null) return null;
  const { held, dropped } = body as { held?: unknown; dropped?: unknown };
  if (!Array.isArray(held) || !Array.isArray(dropped)) return null;
  return {
    held: new Set(held.filter((id): id is string => typeof id === "string")),
    dropped: new Set(dropped.flatMap((entry) => (typeof (entry as { id?: unknown } | null)?.id === "string" ? [(entry as { id: string }).id] : []))),
  };
}

export type HeldReply = HeldAnswer | "no-edge" | "signed-out" | "no-answer";

export function heldReply(body: unknown): HeldReply {
  return heldAnswer(body) ?? "no-edge";
}

export function heldReplyAfterFailure(error: unknown): HeldReply {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 404) return "no-edge";
  return status === 401 || status === 403 ? "signed-out" : "no-answer";
}

export function nextHeldAskDelay(lastMs: number): number {
  return Math.min(HELD_ASK_CAP_MS, lastMs * 2);
}

export function heldAskGroups<T>(sends: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (let start = 0; start < sends.length; start += HELD_ASK_MAX) groups.push(sends.slice(start, start + HELD_ASK_MAX));
  return groups;
}

export function sortHeldSends(asked: readonly HeldSend[], reply: HeldReply, now: number): { keep: HeldSend[]; lost: HeldSend[]; gone: HeldSend[] } {
  const keep: HeldSend[] = [];
  const lost: HeldSend[] = [];
  const gone: HeldSend[] = [];
  for (const send of asked) {
    if (reply === "no-answer" || reply === "signed-out") keep.push(send);
    else if (reply === "no-edge") (now - send.at < HELD_GIVE_UP_MS ? keep : lost).push(send);
    else if (reply.held.has(send.sendId)) keep.push(send);
    else if (reply.dropped.has(send.sendId)) lost.push(send);
    else gone.push(send);
  }
  return { keep, lost, gone };
}
