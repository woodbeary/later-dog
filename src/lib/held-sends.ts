export const HELD_SENDS_KEY = "laterdog-held-sends";
export const HELD_GIVE_UP_MS = 65 * 60 * 1000;
export const HELD_NOT_SENT = "Your home never took this message, so it was not sent. It is kept below to send again.";

export interface HeldSend {
  sendId: string;
  threadId: string;
  draftId: string;
  text: string;
  requestText: string;
  replyToId?: string;
  at: number;
}

export interface HeldAnswer {
  held: ReadonlySet<string>;
  dropped: ReadonlySet<string>;
}

type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function heldSend(value: unknown): HeldSend | null {
  if (typeof value !== "object" || value === null) return null;
  const { sendId, threadId, draftId, text, requestText, replyToId, at } = value as Record<string, unknown>;
  if (typeof sendId !== "string" || typeof threadId !== "string" || typeof draftId !== "string" || typeof text !== "string" || typeof requestText !== "string" || typeof at !== "number") return null;
  return { sendId, threadId, draftId, text, requestText, at, ...(typeof replyToId === "string" ? { replyToId } : {}) };
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

export function sortHeldSends(waiting: readonly HeldSend[], answer: HeldAnswer | null, now: number): { keep: HeldSend[]; lost: HeldSend[] } {
  const keep: HeldSend[] = [];
  const lost: HeldSend[] = [];
  for (const send of waiting) {
    if (answer?.dropped.has(send.sendId)) lost.push(send);
    else if (answer ? answer.held.has(send.sendId) : now - send.at < HELD_GIVE_UP_MS) keep.push(send);
    else if (!answer) lost.push(send);
  }
  return { keep, lost };
}
