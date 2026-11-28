import { messageIndexFields } from "./history-message-index.ts";
import type { HistorySql } from "./history-values.ts";

type Fts = "messages_fts" | "history_text_parts";
export type RecallCorpus = { documents: number; tokens: number; frequency: number[] };
type CorpusPair = { main: RecallCorpus; parts: RecallCorpus; logical: RecallCorpus };
type Match = {
  rid: string;
  id: string;
  at: number;
  role: string;
  kind: string;
  head: string;
  name: string | null;
  peer: string | null;
  snippet: string;
  score: number;
};
type Nominee = { rid: string; at: number; digest: number; score: number; part: string | null };

function sqliteIntegers(hex: string): number[] {
  const values: number[] = [];
  let n = 0;
  for (let at = 0; at < hex.length; at += 2) {
    const byte = parseInt(hex.slice(at, at + 2), 16);
    n = n * 128 + (byte & 127);
    if (byte < 128) {
      values.push(n);
      n = 0;
    }
  }
  return values;
}
function count(sql: HistorySql, query: string, ...bindings: (string | number)[]) {
  return [...sql.exec<{ n: number }>(query, ...bindings)][0].n;
}
function physicalStats(sql: HistorySql, fts: Fts, terms: readonly string[]): RecallCorpus {
  const hex = [...sql.exec<{ sizes: string }>("SELECT hex(block) sizes FROM " + fts + "_data WHERE id=1")][0]?.sizes;
  let [documents, tokens] = sqliteIntegers(hex ?? "");
  if (documents === undefined || tokens === undefined) {
    documents = 0;
    tokens = 0;
    for (const r of sql.exec<{ sz: string }>("SELECT hex(sz) sz FROM " + fts + "_docsize")) {
      documents++;
      tokens += sqliteIntegers(r.sz)[0] ?? 0;
    }
  }
  const frequency = documents
    ? terms.map((term) => count(sql, "SELECT count(*) n FROM " + fts + " WHERE " + fts + " MATCH ?", term))
    : terms.map(() => 0);
  return { documents, tokens, frequency };
}
function columnSizes(sql: HistorySql, fts: Fts, where: string, ...bindings: string[]) {
  let n = 0;
  for (const r of sql.exec<{ sz: string }>("SELECT hex(sz) sz FROM " + fts + "_docsize WHERE " + where, ...bindings))
    n += sqliteIntegers(r.sz)[0] ?? 0;
  return n;
}
function corpus(sql: HistorySql, terms: readonly string[]): CorpusPair {
  const main = physicalStats(sql, "messages_fts", terms),
    parts = physicalStats(sql, "history_text_parts", terms);
  if (!parts.documents) return { main, parts, logical: main };
  const projected = columnSizes(
    sql,
    "messages_fts",
    "id IN (SELECT CAST(entry AS INTEGER) FROM history_values WHERE relation='messages' AND field='text')",
  );
  const frequency = terms.map((term) =>
    count(
      sql,
      "SELECT count(*) n FROM (SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? UNION SELECT CAST(entry AS INTEGER) FROM history_text_parts WHERE history_text_parts MATCH ?)",
      term,
      term,
    ),
  );
  return {
    main,
    parts,
    logical: { documents: main.documents, tokens: main.tokens + parts.tokens - projected, frequency },
  };
}
export function historyRecallStats(sql: HistorySql, terms: string[]) {
  return corpus(sql, terms).logical;
}
export function combinedRecallStats(parts: readonly RecallCorpus[], n: number): RecallCorpus {
  const total = { documents: 0, tokens: 0, frequency: Array.from({ length: n }, () => 0) };
  for (const p of parts) {
    total.documents += p.documents;
    total.tokens += p.tokens;
    for (let i = 0; i < n; i++) total.frequency[i] += p.frequency[i];
  }
  return total;
}
function idf(c: RecallCorpus, i: number) {
  const value=Math.log((c.documents-c.frequency[i]+.5)/(c.frequency[i]+.5));
  return value>0?value:1e-6;
}
function normalizer(c: RecallCorpus, length: number) {
  return 1.2 * (0.25 + (0.75 * length) / (c.tokens / c.documents));
}
function termCount(score: number, c: RecallCorpus, i: number, length: number): number {
  const ratio = -score / (2.2 * idf(c, i));
  return ratio > 0 ? Math.max(1, Math.round((ratio * normalizer(c, length)) / (1 - ratio))) : 0;
}
function rank(global: RecallCorpus, frequencies: number[], length: number) {
  const k = normalizer(global, length);
  return frequencies.reduce((sum, f, i) => sum - (f ? (idf(global, i) * f * 2.2) / (f + k) : 0), 0);
}
function order(a: Nominee, b: Nominee) {
  return (
    a.digest - b.digest ||
    a.score - b.score ||
    b.at - a.at ||
    (BigInt(a.rid) < BigInt(b.rid) ? -1 : BigInt(a.rid) > BigInt(b.rid) ? 1 : 0)
  );
}
export function rankedHistoryRecall(
  sql: HistorySql,
  thread: string,
  match: string,
  terms: string[],
  any: boolean,
  since: number,
  until: number,
  limit: number,
  global?: RecallCorpus,
): Match[] {
  if (!terms.length || !limit) return [];
  const local = corpus(sql, terms),
    all = global ?? local.logical;
  const best: Nominee[] = [];
  const consider = (next: Nominee) => {
    if (best.length === limit && order(next, best[best.length - 1]) >= 0) return;
    best.push(next);
    best.sort(order);
    if (best.length > limit) best.pop();
  };
  for (const m of sql.exec<{ rid: string; at: number; digest: number; sz: string }>(
    "SELECT CAST(m.rowid AS TEXT) rid,m.at,(m.kind='digest') digest,hex(d.sz) sz FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid JOIN messages_fts_docsize d ON d.id=m.rowid WHERE messages_fts MATCH ? AND m.thread_id=? AND m.kind IN ('text','digest') AND m.at BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM history_values WHERE relation='messages' AND entry=CAST(m.rowid AS TEXT) AND field='text')",
    match,
    thread,
    since,
    until,
  )) {
    const length = sqliteIntegers(m.sz)[0] ?? 0;
    const occurrences = terms.map((term, i) => {
      const row = [
        ...sql.exec<{ score: number }>(
          "SELECT bm25(messages_fts) score FROM messages_fts WHERE rowid=CAST(? AS INTEGER) AND messages_fts MATCH ?",
          m.rid,
          term,
        ),
      ][0];
      return row ? termCount(row.score, local.main, i, length) : 0;
    });
    consider({ rid: m.rid, at: m.at, digest: m.digest, score: rank(all, occurrences, length), part: null });
  }
  if (local.parts.documents)
    for (const m of sql.exec<{ rid: string; at: number; digest: number }>(
      "SELECT CAST(m.rowid AS TEXT) rid,m.at,(m.kind='digest') digest FROM messages m WHERE m.thread_id=? AND m.at BETWEEN ? AND ? AND m.kind IN ('text','digest') AND EXISTS (SELECT 1 FROM history_values WHERE relation='messages' AND entry=CAST(m.rowid AS TEXT) AND field='text')",
      thread,
      since,
      until,
    )) {
      const length = columnSizes(
        sql,
        "history_text_parts",
        "id IN (SELECT rowid FROM history_text_parts WHERE entry=?)",
        m.rid,
      );
      let bestPart: string | null = null,
        bestScore = 0;
      const occurrences = terms.map((term, i) => {
        let sum = 0;
        for (const row of sql.exec<{ rid: string; score: number; sz: string }>(
          "SELECT CAST(p.rowid AS TEXT) rid,bm25(history_text_parts) score,hex(d.sz) sz FROM history_text_parts p JOIN history_text_parts_docsize d ON d.id=p.rowid WHERE history_text_parts MATCH ? AND p.entry=?",
          term,
          m.rid,
        )) {
          sum += termCount(row.score, local.parts, i, sqliteIntegers(row.sz)[0] ?? 0);
          if (row.score < bestScore) {
            bestScore = row.score;
            bestPart = row.rid;
          }
        }
        return sum;
      });
      if (bestPart !== null && (any || occurrences.every(Boolean)))
        consider({ rid: m.rid, at: m.at, digest: m.digest, score: rank(all, occurrences, length), part: bestPart });
    }
  return best.map((item) => {
    const r = [
      ...sql.exec<Omit<Match, "score" | "snippet">>(
        "SELECT CAST(rowid AS TEXT) rid,id,at,role,kind,substr(text,1,160) head,json_extract(json,'$.from.name') name,json_extract(json,'$.peerAsk.name') peer FROM messages WHERE rowid=CAST(? AS INTEGER)",
        item.rid,
      ),
    ][0];
    const f = item.part === null ? "messages_fts" : "history_text_parts";
    const term = item.part === null ? match : terms.join(" OR ");
    const snippet = [
      ...sql.exec<{ s: string }>(
        "SELECT snippet(" +
          f +
          ",0,'[',']','…',48) s FROM " +
          f +
          " WHERE " +
          f +
          " MATCH ? AND rowid=CAST(? AS INTEGER)",
        term,
        item.part ?? item.rid,
      ),
    ][0].s;
    const projected=[...sql.exec<{json:string}>("SELECT json FROM messages WHERE rowid=CAST(? AS INTEGER) AND json_extract(json,'$.extendedIndex')=1",item.rid)][0];
    if(projected){const m=messageIndexFields(sql,item.rid,projected.json);r.name=m.from?.name??null;r.peer=m.peerAsk?.name??null;}
    return { ...r, snippet, score: item.score };
  });
}
