import type { HeldSend } from "./held-sends";

export const HELD_THREAD_READ_LIMIT = 200;
export const HELD_THREAD_READ_TIMEOUT_MS = 10_000;
export const EDGE_SAVED_COPY_HEADER = "x-laterdog-saved-at";
export const HOME_NO_SUCH_THREAD = "no such conversation";
export const HOME_QUEUES_PATH = "/api/bots?messages=0";

type Line = { id?: unknown; sendId?: unknown };

export type FetchThread = (path: string, init: RequestInit) => Promise<Response>;

export function isHomeLine(line: Line): boolean {
  return typeof line.id === "string" && !line.id.startsWith("optimistic-") && !line.id.startsWith("desk-");
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

export interface HomeQueues {
  queued: ReadonlySet<string>;
  busyRoomThreads: ReadonlySet<string>;
}

type Room = { threadId?: unknown; working?: unknown; busyBotId?: unknown; tasks?: unknown };

function queuedAtHome(queues: unknown): string[] {
  if (typeof queues !== "object" || queues === null) return [];
  return Object.values(queues as Record<string, unknown>).flatMap((rows) =>
    Array.isArray(rows)
      ? rows.flatMap((row) => {
          const { sendId, queueId } = (row ?? {}) as { sendId?: unknown; queueId?: unknown };
          return typeof sendId === "string" && sendId && queueId !== sendId ? [sendId] : [];
        })
      : [],
  );
}

function busyRoomThreads(rooms: unknown): string[] {
  if (!Array.isArray(rooms)) return [];
  return rooms.flatMap((room: Room) => {
    if (!room || (room.working !== true && !room.busyBotId)) return [];
    const tasks = Array.isArray(room.tasks) ? room.tasks.map((task: { threadId?: unknown }) => task?.threadId) : [];
    return [room.threadId, ...tasks].filter((threadId): threadId is string => typeof threadId === "string" && threadId.length > 0);
  });
}

export async function homeQueuesAnswer(response: Response): Promise<HomeQueues | "unreadable"> {
  const body: unknown = await response.json().catch(() => null);
  if (response.status !== 200 || response.headers.has(EDGE_SAVED_COPY_HEADER) || typeof body !== "object" || body === null) return "unreadable";
  const { bots, groups, botQueuedMessages } = body as { bots?: unknown; groups?: unknown; botQueuedMessages?: unknown };
  if (!Array.isArray(bots) || !Array.isArray(groups)) return "unreadable";
  return { queued: new Set(queuedAtHome(botQueuedMessages)), busyRoomThreads: new Set(busyRoomThreads(groups)) };
}

export async function judgeAtHome(
  sends: readonly HeldSend[],
  queues: HomeQueues | "unreadable",
  read: (threadId: string) => Promise<ThreadRead>,
): Promise<{ delivered: HeldSend[]; notSent: HeldSend[]; unread: HeldSend[] }> {
  const delivered: HeldSend[] = [];
  const notSent: HeldSend[] = [];
  const unread: HeldSend[] = [];
  const unqueued = sends.filter((send) => queues === "unreadable" || !queues.queued.has(send.sendId));
  const reads = new Map(unqueued.map((send) => [send.threadId, read(send.threadId)]));
  for (const send of sends) {
    if (!unqueued.includes(send)) {
      delivered.push(send);
      continue;
    }
    const lines = await reads.get(send.threadId)!;
    if (lines === "missing") notSent.push(send);
    else if (lines !== "unreadable" && lines.has(send.sendId)) delivered.push(send);
    else if (lines === "unreadable" || queues === "unreadable" || queues.busyRoomThreads.has(send.threadId)) unread.push(send);
    else notSent.push(send);
  }
  return { delivered, notSent, unread };
}
