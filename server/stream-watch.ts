import { randomUUID } from "node:crypto";

// A live-events client can opt in to on-screen streaming with `?watch=1`.
// Streamed text and reasoning (`runtime` events of type `content.delta`) then
// reach it only for the chats it says are on screen. Every other event still
// arrives, so lists, working states and finished messages stay current.
// `threads: "all"` turns the filter off again for that stream (the phone's
// Run Check uses it to measure the old behaviour).

export const STREAM_WATCH_MAX = 16;

export interface StreamWatchClient {
  watchId?: string;
  watch?: Set<string> | "all";
  sessionId?: string;
}

export function openStreamWatch(client: StreamWatchClient, params: URLSearchParams): void {
  if (params.get("watch") !== "1") return;
  client.watchId = randomUUID();
  client.watch = new Set();
}

export function streamWatchSkips(client: StreamWatchClient, payload: Record<string, unknown>): boolean {
  if (!client.watch || client.watch === "all" || payload.kind !== "runtime") return false;
  const event = payload.event as { type?: unknown; threadId?: unknown } | undefined;
  if (!event || event.type !== "content.delta") return false;
  return typeof event.threadId === "string" && event.threadId !== "" && !client.watch.has(event.threadId);
}

export type StreamWatchUpdate =
  | { ok: true; threads: string[] | "all" }
  | { ok: false; status: 400 | 404; error: string };

export function parseStreamWatch(body: unknown): { id: string; threads: string[] | "all" } | null {
  if (!body || typeof body !== "object") return null;
  const { id, threads } = body as { id?: unknown; threads?: unknown };
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  if (threads === "all") return { id, threads };
  if (!Array.isArray(threads) || threads.length > STREAM_WATCH_MAX) return null;
  if (!threads.every((thread) => typeof thread === "string" && thread.length > 0 && thread.length <= 128)) return null;
  return { id, threads: [...new Set(threads as string[])] };
}

export function updateStreamWatch(
  clients: Iterable<StreamWatchClient>,
  body: unknown,
  sessionId: string | undefined,
): StreamWatchUpdate {
  const parsed = parseStreamWatch(body);
  if (!parsed) return { ok: false, status: 400, error: `send { id, threads } with at most ${STREAM_WATCH_MAX} thread ids` };
  for (const client of clients) {
    if (client.watchId !== parsed.id || !client.watch) continue;
    if (client.sessionId !== sessionId) break;
    client.watch = parsed.threads === "all" ? "all" : new Set(parsed.threads);
    return { ok: true, threads: parsed.threads };
  }
  return { ok: false, status: 404, error: "that live stream is gone; reconnect and try again" };
}
