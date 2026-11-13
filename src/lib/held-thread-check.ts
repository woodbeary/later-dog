import type { HeldSend } from "./held-sends";

export const HELD_THREAD_READ_LIMIT = 200;
export const HELD_THREAD_READ_TIMEOUT_MS = 10_000;
export const EDGE_SAVED_COPY_HEADER = "x-laterdog-saved-at";
export const HOME_NO_SUCH_THREAD = "no such conversation";
export const HOME_QUEUES_PATH = "/api/bots?messages=0";
export const HELD_PAGES_PER_SEND = 10;
export const HELD_PAGE_BACK_SLACK_MS = 10 * 60_000;

type Line = { id?: unknown; sendId?: unknown };

export type FetchThread = (path: string, init: RequestInit) => Promise<Response>;

export function isHomeLine(line: Line): boolean {
  return typeof line.id === "string" && !line.id.startsWith("optimistic-") && !line.id.startsWith("desk-");
}

export type ThreadRead = { lines: ReadonlySet<string>; complete: boolean } | "missing";

export type ThreadPage = { lines: ReadonlySet<string>; hasMore: boolean; oldestId?: string; oldestAt?: number } | "missing" | "unreadable";

export function heldThreadPath(threadId: string, before?: string): string {
  const page = `/api/threads/${encodeURIComponent(threadId)}/messages?limit=${HELD_THREAD_READ_LIMIT}`;
  return before ? `${page}&before=${encodeURIComponent(before)}` : page;
}

export async function threadPageAnswer(response: Response): Promise<ThreadPage> {
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 404) {
    const said = (body as { error?: unknown } | null)?.error;
    return said === HOME_NO_SUCH_THREAD ? "missing" : "unreadable";
  }
  if (response.status !== 200 || response.headers.has(EDGE_SAVED_COPY_HEADER)) return "unreadable";
  const { messages, hasMore } = (body ?? {}) as { messages?: unknown; hasMore?: unknown };
  if (!Array.isArray(messages)) return "unreadable";
  const oldest = messages[0] as (Line & { at?: unknown }) | undefined;
  return {
    lines: new Set(messages.flatMap((line: Line) => (line && typeof line.sendId === "string" && isHomeLine(line) ? [line.sendId] : []))),
    hasMore: hasMore === true,
    ...(typeof oldest?.id === "string" ? { oldestId: oldest.id } : {}),
    ...(typeof oldest?.at === "number" ? { oldestAt: oldest.at } : {}),
  };
}

export async function readThreadBack(
  readPage: (path: string) => Promise<ThreadPage>,
  threadId: string,
  since: number,
  wanted: ReadonlySet<string>,
): Promise<ThreadRead> {
  const lines = new Set<string>();
  let before: string | undefined;
  for (let read = 0; read < HELD_PAGES_PER_SEND; read++) {
    const page = await readPage(heldThreadPath(threadId, before));
    if (page === "missing" && read === 0) return "missing";
    if (page === "missing" || page === "unreadable") return { lines, complete: false };
    for (const sendId of page.lines) lines.add(sendId);
    if ([...wanted].every((sendId) => lines.has(sendId))) return { lines, complete: true };
    if (!page.hasMore || (page.oldestAt !== undefined && page.oldestAt < since - HELD_PAGE_BACK_SLACK_MS)) return { lines, complete: true };
    if (!page.oldestId) return { lines, complete: false };
    before = page.oldestId;
  }
  return { lines, complete: false };
}

export interface HomeQueues {
  queued: ReadonlySet<string>;
  unnamed: ReadonlySet<string>;
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

function threadsQueuingUnnamed(queues: unknown): string[] {
  if (typeof queues !== "object" || queues === null) return [];
  return Object.entries(queues as Record<string, unknown>).flatMap(([threadId, rows]) =>
    Array.isArray(rows) && rows.some((row) => typeof (row as { sendId?: unknown } | null)?.sendId !== "string") ? [threadId] : [],
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
  return { queued: new Set(queuedAtHome(botQueuedMessages)), unnamed: new Set(threadsQueuingUnnamed(botQueuedMessages)), busyRoomThreads: new Set(busyRoomThreads(groups)) };
}

export async function judgeAtHome(
  sends: readonly HeldSend[],
  queues: HomeQueues | "unreadable",
  read: (threadId: string, since: number, wanted: ReadonlySet<string>) => Promise<ThreadRead>,
): Promise<{ delivered: HeldSend[]; notSent: HeldSend[]; unread: HeldSend[] }> {
  const delivered: HeldSend[] = [];
  const notSent: HeldSend[] = [];
  const unread: HeldSend[] = [];
  const unqueued = sends.filter((send) => queues === "unreadable" || !queues.queued.has(send.sendId));
  const byThread = new Map<string, HeldSend[]>();
  for (const send of unqueued) byThread.set(send.threadId, [...(byThread.get(send.threadId) ?? []), send]);
  const reads = new Map(
    [...byThread].map(([threadId, waiting]) => [
      threadId,
      read(threadId, Math.min(...waiting.map((send) => send.at)), new Set(waiting.map((send) => send.sendId))),
    ]),
  );
  for (const send of sends) {
    if (!unqueued.includes(send)) {
      delivered.push(send);
      continue;
    }
    const thread = await reads.get(send.threadId)!;
    if (thread === "missing") notSent.push(send);
    else if (thread.lines.has(send.sendId)) delivered.push(send);
    else if (!thread.complete || queues === "unreadable" || queues.unnamed.has(send.threadId) || queues.busyRoomThreads.has(send.threadId)) unread.push(send);
    else notSent.push(send);
  }
  return { delivered, notSent, unread };
}
