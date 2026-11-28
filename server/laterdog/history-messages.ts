import { combinedRecallStats, type RecallCorpus } from "../../shared/history-recall.ts";
import type { Message } from "../store.ts";
import type { ThreadTailRows, RecallHit, RecallRange, SearchMode, ThreadLatest } from "../message-db.ts";
import type { SearchHit } from "../message-search-query.ts";
import { peerProvenanceAuthor } from "../peer-provenance.ts";
import { historyExecute, historyMany, historyManyAsync } from "./history-client.ts";
type Page = ThreadTailRows & { next: string | null };
export function remoteThread(thread: string, limit?: number): ThreadTailRows {
  const messages: Message[] = [];
  let after: string | null = null,
    leaf: string | null = null,
    more = false;
  do {
    const page: Page = historyExecute(thread, {
      op: "messages.page",
      after,
      backward: limit !== undefined,
      limit: limit === undefined ? 500 : Math.min(64, Math.max(0, limit - messages.length)),
    });
    leaf = page.activeLeafId;
    more = !!page.hasMore;
    messages.push(...page.messages);
    if (page.next !== null && after === page.next) throw Error("Conversation returned a repeated page");
    after = page.next;
  } while (after && (limit === undefined || messages.length < limit));
  return limit === undefined
    ? { messages, activeLeafId: leaf }
    : { messages: messages.reverse(), activeLeafId: leaf, hasMore: more };
}
export function remoteCards(permission: boolean, threads?: readonly string[]) {
  return historyMany<Message[]>(threads, { op: "messages.cards", permission }).flatMap(({ threadId, result }) =>
    result.map((message) => ({ threadId, message })),
  );
}
export function remoteLatest(ids: readonly string[], person: boolean) {
  return new Map(
    historyMany<number | null>(ids, { op: "messages.latest", person }).flatMap(({ threadId, result }) =>
      result === null ? [] : [[threadId, result] as const],
    ),
  );
}
function chronological(a: { at: number; rid?: string }, b: { at: number; rid?: string }) {
  return (
    b.at - a.at || (BigInt(a.rid ?? 0) < BigInt(b.rid ?? 0) ? -1 : BigInt(a.rid ?? 0) > BigInt(b.rid ?? 0) ? 1 : 0)
  );
}
function searchHits(rows: { result: (SearchHit & { rid?: string })[] }[], limit: number) {
  return rows
    .flatMap((r) => r.result)
    .sort(chronological)
    .slice(0, limit)
    .map((hit) => {
      const result = { ...hit };
      delete result.rid;
      return result;
    });
}
export function remoteSearch(query: string, limit: number, thread?: string) {
  return searchHits(
    historyMany<SearchHit[]>(thread ? [thread] : undefined, { op: "messages.search", query, limit, activePath: true }),
    limit,
  );
}
export async function remoteSearchAsync(query: string, limit: number, thread?: string) {
  return searchHits(
    await historyManyAsync<SearchHit[]>(thread ? [thread] : undefined, {
      op: "messages.search",
      query,
      limit,
      activePath: true,
    }),
    limit,
  );
}
export function remoteText(threadId: string, messageId: string) {
  const row = historyExecute<{ at: number; role: string; text: string; from?: string; peer?: string } | null>(
    threadId,
    { op: "messages.text", id: messageId },
  );
  if (!row) return null;
  const peer = row.peer ?? peerProvenanceAuthor(row.text);
  return {
    threadId,
    messageId,
    at: row.at,
    role: row.role,
    text: row.text,
    ...(row.from ? { from: row.from } : {}),
    ...(peer ? { peer } : {}),
  };
}
type RecallRow = {
  id: string;
  rid: string;
  at: number;
  role: string;
  kind: string;
  head: string;
  name: string | null;
  peer: string | null;
  snippet: string;
  score: number;
};
export function remoteRecall(
  threads: readonly string[],
  match: string,
  terms: string[],
  mode: SearchMode,
  range: RecallRange | undefined,
  limit: number,
): RecallHit[] {
  const corpus = combinedRecallStats(
    historyMany<RecallCorpus>(undefined, { op: "messages.recallStats", terms }).map((x) => x.result),
    terms.length,
  );
  return rankedRecall(historyMany<RecallRow[]>(threads, recallOperation(match, terms, corpus, mode, range, limit)), limit);
}
export async function remoteRecallAsync(
  threads: readonly string[],
  match: string,
  terms: string[],
  mode: SearchMode,
  range: RecallRange | undefined,
  limit: number,
): Promise<RecallHit[]> {
  const stats = await historyManyAsync<RecallCorpus>(undefined, { op: "messages.recallStats", terms });
  const corpus = combinedRecallStats(stats.map(row => row.result), terms.length);
  const rows = await historyManyAsync<RecallRow[]>(threads, recallOperation(match, terms, corpus, mode, range, limit));
  return rankedRecall(rows, limit);
}
function recallOperation(match: string, terms: string[], corpus: RecallCorpus, mode: SearchMode, range: RecallRange | undefined, limit: number) {
  return { op: "messages.recall", match, terms, corpus, any: mode === "any", ...range, limit };
}
function rankedRecall(rows: { threadId: string; result: RecallRow[] }[], limit: number): RecallHit[] {
  return rows
    .flatMap(({ threadId, result }) => result.map((r) => ({ ...r, threadId })))
    .sort(
      (a, b) => Number(a.kind === "digest") - Number(b.kind === "digest") || a.score - b.score || chronological(a, b),
    )
    .slice(0, limit)
    .map((r) => {
      const peer = r.peer ?? peerProvenanceAuthor(r.head);
      return {
        threadId: r.threadId,
        messageId: r.id,
        at: r.at,
        role: r.role,
        ...(r.kind === "digest" ? { kind: "digest" as const } : {}),
        snippet: r.snippet.replace(/\s+/g, " ").trim(),
        ...(r.name ? { from: r.name } : {}),
        ...(peer ? { peer } : {}),
      };
    });
}
export function remoteRecent(threads: readonly string[], range: RecallRange, limit: number): RecallHit[] {
  return historyMany<(ThreadLatest & { role: string; from?: string; peer?: string })[]>(threads, {
    op: "messages.recent",
    ...range,
    limit,
  })
    .flatMap((x) => x.result)
    .sort(chronological)
    .slice(0, limit)
    .map((r) => {
      const peer = r.peer ?? peerProvenanceAuthor(r.head);
      return {
        threadId: r.threadId,
        messageId: r.messageId,
        at: r.at,
        role: r.role,
        snippet: r.head,
        ...(r.from ? { from: r.from } : {}),
        ...(peer ? { peer } : {}),
      };
    });
}
export function remoteLatestBot(
  threads: readonly string[],
  botId: string,
  since: number,
  limit: number,
): ThreadLatest[] {
  return historyMany<ThreadLatest[]>(threads, { op: "messages.latestBot", botId, since, limit })
    .flatMap((x) => x.result)
    .sort(chronological)
    .slice(0, limit)
    .map(({ threadId, messageId, at, head }) => ({ threadId, messageId, at, head }));
}
