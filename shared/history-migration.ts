export const HISTORY_TABLES = [
  "messages",
  "thread_state",
  "native_runs",
  "native_run_events",
  "native_run_items",
  "native_run_retention",
] as const;

export type HistoryTable = typeof HISTORY_TABLES[number];

export const HISTORY_COLUMNS = {
  messages: ["thread_id", "id", "at", "role", "kind", "text", "json"],
  thread_state: ["thread_id", "active_leaf_id"],
  native_runs: ["id", "thread_id", "started_at", "json", "event_sequence", "sealed"],
  native_run_events: ["sequence", "run_id", "event_id", "at", "json"],
  native_run_items: ["run_id", "id", "sequence", "json"],
  native_run_retention: ["thread_id"],
} as const satisfies Record<HistoryTable, readonly string[]>;

export const HISTORY_INTEGER_COLUMNS: Record<HistoryTable, readonly string[]> = {
  messages: ["at"],
  thread_state: [],
  native_runs: ["started_at", "event_sequence", "sealed"],
  native_run_events: ["sequence", "at"],
  native_run_items: ["sequence"],
  native_run_retention: [],
};

const nullable: Record<HistoryTable, readonly string[]> = {
  messages: ["text"],
  thread_state: ["active_leaf_id"],
  native_runs: [],
  native_run_events: [],
  native_run_items: [],
  native_run_retention: [],
};

export type HistoryRow = readonly [rowid: string, ...columns: (string | null)[]];

export interface HistoryTableProof {
  count: number;
  bytes: number;
  sha256: string;
}

export type HistoryTableProofs = Record<HistoryTable, HistoryTableProof>;

export interface HistoryThreadProof {
  v: 1;
  threadId: string;
  tables: HistoryTableProofs;
  sha256: string;
}

export function historyInteger(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|-?[1-9][0-9]{0,18})$/.test(value)) return false;
  const integer = BigInt(value);
  return integer >= -9223372036854775808n && integer <= 9223372036854775807n;
}

export function validHistoryRow(table: HistoryTable, value: unknown): value is HistoryRow {
  if (!Array.isArray(value) || !historyInteger(value[0])) return false;
  const columns: readonly string[] = HISTORY_COLUMNS[table];
  if (value.length !== columns.length + 1) return false;
  if (table === "native_run_events" && value[0] !== value[1]) return false;
  return columns.every((name, i) => {
    const field: unknown = value[i + 1];
    if (field === null) return nullable[table].includes(name);
    return HISTORY_INTEGER_COLUMNS[table].includes(name) ? historyInteger(field) : typeof field === "string";
  });
}

const encoder = new TextEncoder();

export function historyRowLine(row: HistoryRow): Uint8Array {
  return encoder.encode(JSON.stringify(row) + "\n");
}

export function historyThreadProofBytes(threadId: string, tables: HistoryTableProofs): Uint8Array {
  return encoder.encode(JSON.stringify([1, threadId, ...HISTORY_TABLES.map(table => {
    const p = tables[table];
    return [table, p.count, p.bytes, p.sha256];
  })]));
}
