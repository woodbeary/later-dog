import type { HeldSend } from "./held-sends";

export const HELD_THREAD_READ_LIMIT = 200;
export const HELD_THREAD_READ_TIMEOUT_MS = 10_000;
export const EDGE_SAVED_COPY_HEADER = "x-laterdog-saved-at";
export const HOME_NO_SUCH_THREAD = "no such conversation";

type Line = { id?: unknown; sendId?: unknown };
type Chat = { threadId?: unknown; messages?: readonly Line[] };

export type FetchThread = (path: string, init: RequestInit) => Promise<Response>;

export function isHomeLine(line: Line): boolean {
  return typeof line.id === "string" && !line.id.startsWith("optimistic-") && !line.id.startsWith("desk-");
}

export function threadsCoveredBy(chats: readonly Chat[]): Set<string> {
  return new Set(chats.flatMap((chat) => (typeof chat.threadId === "string" && chat.threadId ? [chat.threadId] : [])));
}

export type ThreadRead = ReadonlySet<string> | "missing" | "unreadable";

export function heldThreadPath(threadId: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/messages?limit=${HELD_THREAD_READ_LIMIT}`;
}

export async function threadAnswer(response: Response): Promise<ThreadRead> {
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 404) {
    const said = (body as { error?: unknown } | null)?.error;
    return said === HOME_NO_SUCH_THREAD ? "missing" : "unreadable";
  }
  if (response.status !== 200 || response.headers.has(EDGE_SAVED_COPY_HEADER)) return "unreadable";
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return "unreadable";
  return new Set(messages.flatMap((line: Line) => (line && typeof line.sendId === "string" && isHomeLine(line) ? [line.sendId] : [])));
}

export function threadReader(fetchThread: FetchThread): (threadId: string) => Promise<ThreadRead> {
  const reads = new Map<string, Promise<ThreadRead>>();
  return (threadId) => {
    let read = reads.get(threadId);
    if (!read) {
      read = fetchThread(heldThreadPath(threadId), { headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(HELD_THREAD_READ_TIMEOUT_MS) }).then(
        threadAnswer,
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
    else if (lines === "missing" || !lines.has(send.sendId)) notSent.push(send);
    else delivered.push(send);
  }
  return { delivered, notSent, unread };
}
