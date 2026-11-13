import type { HeldSend } from "./held-sends";

export const HELD_THREAD_READ_LIMIT = 200;

type Line = { id?: unknown; sendId?: unknown };
type Chat = { threadId?: unknown; messages?: readonly Line[] };
type Request = (path: string, init: { timeoutMs?: number; rideWake?: boolean }) => Promise<unknown>;

export function isHomeLine(line: Line): boolean {
  return typeof line.id === "string" && !line.id.startsWith("optimistic-") && !line.id.startsWith("desk-");
}

export function threadsCoveredBy(chats: readonly Chat[]): Set<string> {
  return new Set(chats.flatMap((chat) => (typeof chat.threadId === "string" && chat.threadId ? [chat.threadId] : [])));
}

export type ThreadRead = ReadonlySet<string> | "unreadable";

export function threadReader(request: Request): (threadId: string) => Promise<ThreadRead> {
  const reads = new Map<string, Promise<ThreadRead>>();
  return (threadId) => {
    let read = reads.get(threadId);
    if (!read) {
      read = request(`/api/threads/${encodeURIComponent(threadId)}/messages?limit=${HELD_THREAD_READ_LIMIT}`, { timeoutMs: 10_000, rideWake: false }).then(
        (body): ThreadRead => {
          const messages = (body as { messages?: unknown } | null)?.messages;
          if (!Array.isArray(messages)) return "unreadable";
          return new Set(messages.flatMap((line: Line) => (line && typeof line.sendId === "string" && isHomeLine(line) ? [line.sendId] : [])));
        },
        (): ThreadRead => "unreadable",
      );
      reads.set(threadId, read);
    }
    return read;
  };
}

export async function judgeUnconfirmed(
  sends: readonly HeldSend[],
  covered: ReadonlySet<string>,
  read: (threadId: string) => Promise<ThreadRead>,
): Promise<{ delivered: HeldSend[]; notSent: HeldSend[]; unread: HeldSend[] }> {
  const delivered: HeldSend[] = [];
  const notSent: HeldSend[] = [];
  const unread: HeldSend[] = [];
  for (const send of sends) {
    if (covered.has(send.threadId)) {
      notSent.push(send);
      continue;
    }
    const lines = await read(send.threadId);
    if (lines === "unreadable") unread.push(send);
    else if (lines.has(send.sendId)) delivered.push(send);
    else notSent.push(send);
  }
  return { delivered, notSent, unread };
}
