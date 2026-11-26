import type { HistorySql } from "./history-values.ts";
import { readHistoryValue } from "./history-values.ts";
import type { HistoryOperation } from "./history-shard-types.ts";

export interface BranchPoint {
  id: string;
  parentId?: string | null;
  role: string;
  kind: string;
  at: number;
}
export function conversationVersions(messages: readonly BranchPoint[], leaf: string | null) {
  const byId = new Map(messages.map((message) => [message.id, message])),
    forks = new Map<string | null, BranchPoint[]>();
  for (const m of messages)
    if (m.role === "user" && m.kind === "text") {
      const key = m.parentId ?? null,
        prior = forks.get(key);
      if (prior) prior.push(m);
      else forks.set(key, [m]);
    }
  const versions: Record<string, { index: number; count: number; ids: string[] }> = {},
    seen = new Set<string>();
  while (leaf && !seen.has(leaf)) {
    seen.add(leaf);
    const m = byId.get(leaf);
    if (!m) break;
    const siblings = forks.get(m.parentId ?? null);
    if (m.role === "user" && m.kind === "text" && siblings && siblings.length > 1) {
      const ids = siblings.sort((a, b) => a.at - b.at).map((s) => s.id);
      ids.forEach((id, i) => {
        versions[id] = { index: i + 1, count: ids.length, ids };
      });
    }
    leaf = m.parentId ?? null;
  }
  return versions;
}

export function historyNavigation(sql: HistorySql, thread: string, op: HistoryOperation) {
  type Point = { id:string; parentId:string|null;role:string;kind:string;at:number;rid:string;defined:number;overflow:number };
  const nodes: Point[] = [];
  let previous: string | null = null;
  for (const node of sql.exec<Point>(
    `SELECT CAST(m.rowid AS TEXT) rid,id,role,kind,at,json_extract(json,'$.parentId') parentId,json_type(json,'$.parentId') IS NOT NULL AS defined,EXISTS(SELECT 1 FROM history_values h WHERE h.relation='messages' AND h.entry=CAST(m.rowid AS TEXT) AND h.field='json' LIMIT 1) overflow FROM messages m WHERE thread_id=? ORDER BY rowid`,
    thread,
  )) {
    if (node.overflow) {
      const message = JSON.parse(readHistoryValue(sql, "messages", node.rid, "json", ""));
      node.parentId = message.parentId === undefined ? previous : message.parentId;
    } else if (!node.defined) node.parentId = previous;
    nodes.push(node);
    previous = node.id;
  }
  const leaf =
    Array.from(
      sql.exec<{ leaf: string | null }>("SELECT active_leaf_id AS leaf FROM thread_state WHERE thread_id=?", thread),
    )[0]?.leaf ?? previous;
  const before = typeof op.before === "string" ? op.before : undefined,
    around = typeof op.around === "string" ? op.around : undefined;
  const id = around ?? before,
    anchor = id ? nodes.findIndex((n) => n.id === id) : nodes.length;
  if (anchor < 0) return null;
  const limit = op.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0 || limit > 1000)
    throw Error("Invalid conversation page size");
  const start = around
    ? Math.max(0, Math.min(anchor - Math.floor((limit - 1) / 2), nodes.length - limit))
    : Math.max(0, anchor - limit);
  const end = around ? Math.min(nodes.length, start + limit) : anchor;
  return {
    versions: conversationVersions(nodes, leaf),
    activeLeafId: leaf,
    hasMore: start > 0,
    firstAfter: end < nodes.length ? nodes[end].rid : null,
    limit: end - start,
  };
}
