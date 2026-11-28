export const HISTORY_ROUTE = "/api/internal/coordinator/history";
export const MAX_HISTORY_MESSAGE_BYTES = 1_800_000;
export const HISTORY_BATCH_BYTES = 4_000_000;
export const HISTORY_PAGE_MAX = 500;

const ID = /^[\w:.-]{1,160}$/;
const encoder = new TextEncoder();

export function jsonBytes(json: string): number {
  return json.length * 3 <= MAX_HISTORY_MESSAGE_BYTES ? json.length : encoder.encode(json).length;
}

export interface HistoryRow {
  id: string;
  at: number;
  json: string;
}

export interface StoredHistoryRow extends HistoryRow {
  ord: number;
}

export type HistoryChange = ({ op: "put" } & HistoryRow) | { op: "del"; id: string };

export interface HistoryLeaf {
  id: string | null;
}

export interface HistoryPage {
  rows: StoredHistoryRow[];
  more: boolean;
  leaf: string | null;
}

export interface HistoryStats {
  count: number;
  bytes: number;
  maxOrd: number;
  leaf: string | null;
}

export function validHistoryRow(value: unknown): value is HistoryRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && ID.test(row.id) && typeof row.at === "number" && Number.isSafeInteger(row.at) &&
    typeof row.json === "string" && jsonBytes(row.json) <= MAX_HISTORY_MESSAGE_BYTES;
}

export function validHistoryChange(value: unknown): value is HistoryChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Record<string, unknown>;
  if (change.op === "del") return typeof change.id === "string" && ID.test(change.id);
  return change.op === "put" && validHistoryRow(change);
}

export function historyIdOk(id: string): boolean {
  return ID.test(id);
}
