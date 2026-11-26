import type { Message } from "../store.ts";
import type { HistoryOperation } from "../../shared/history-shard-types.ts";
import type { BranchVersion } from "./rewind.ts";
import { historyExecuteAsync, historyManyAsync, isRemoteHistory } from "./history-client.ts";
import { overviewHistory, type HistoryTail } from "./history-snapshot-cache.ts";
type WirePage = HistoryTail & { next: string | null };
async function fill(thread: string, limit: number, first: WirePage) {
  const rows = first.messages;
  let page = first;
  while (rows.length < limit && page.hasMore) {
    const after = page.next;
    if (!after) throw Error("Missing conversation page cursor");
    page = await historyExecuteAsync<WirePage>(thread, {
      op: "messages.page",
      backward: true,
      normalize: true,
      limit: Math.min(500, limit - rows.length),
      after,
    });
    if (page.next === after || (!page.messages.length && page.hasMore))
      throw Error("Conversation returned a repeated page");
    rows.push(...page.messages);
  }
  return { messages: rows.reverse(), hasMore: page.hasMore, activeLeafId: page.activeLeafId };
}
export async function prepareHistoryTails(threads: readonly string[], limit: number) {
  if (!isRemoteHistory()) return () => undefined;
  const witnesses = new Map([...new Set(threads)].map((thread) => [thread, overviewHistory.witness(thread)]));
  const values = new Map<string, HistoryTail>();
  const missing = Array.from(witnesses.keys()).filter((thread) => {
    const cached = overviewHistory.get(witnesses.get(thread)!, limit);
    if (cached) values.set(thread, cached);
    return !cached;
  });
  let cursor = 0;
  const op: HistoryOperation = { op: "messages.page", normalize: true, backward: true, limit: Math.min(500, limit) };
  async function batch() {
    while (cursor < missing.length) {
      const ids = missing.slice(cursor, (cursor += 12));
      const page = await historyManyAsync<WirePage>(ids, op);
      if (page.length !== ids.length) throw Error("Incomplete conversation overview");
      await Promise.all(
        page.map(async ({ threadId, result }) => {
          const tail = await fill(threadId, limit, result);
          values.set(threadId, tail);
          overviewHistory.save(threadId, witnesses.get(threadId)!, limit, tail);
        }),
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, Math.ceil(missing.length / 12)) }, batch));
  return (thread: string) => (overviewHistory.valid(thread, witnesses.get(thread)!) ? values.get(thread) : undefined);
}
async function loadWindow(thread: string, limit: number, before: string | null, around: string | null) {
  const info = await historyExecuteAsync<{
    versions: Record<string, BranchVersion>;
    activeLeafId: string | null;
    hasMore: boolean;
    firstAfter: string | null;
    limit: number;
  } | null>(thread, { op: "messages.navigation", before, around, limit });
  if (!info) return null;
  let messages: Message[] = [];
  if (info.limit > 0) {
    const page = await historyExecuteAsync<WirePage>(thread, {
      op: "messages.page",
      normalize: true,
      backward: true,
      limit: Math.min(info.limit, 500),
      after: info.firstAfter,
    });
    messages = (await fill(thread, info.limit, page)).messages;
  }
  return { messages, activeLeafId: info.activeLeafId, hasMore: info.hasMore, versions: info.versions };
}

export async function historyWindow(thread: string, limit: number, before: string | null, around: string | null) {
  for (;;) {
    const original = overviewHistory.witness(thread);
    const window = await loadWindow(thread, limit, before, around);
    if (overviewHistory.valid(thread, original)) return window;
  }
}
