import type { HistoryTable } from "./history-migration.ts";

type SqlValue = string | number | null | ArrayBuffer;
export interface HistorySql {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): Iterable<T>;
}

const chunkSize = 384 * 1024;
const encoder = new TextEncoder();

export function clearHistoryValues(sql: HistorySql, table: HistoryTable, rowid?: string): void {
  if (rowid === undefined) sql.exec("DELETE FROM history_values WHERE relation = ?", table);
  else sql.exec("DELETE FROM history_values WHERE relation = ? AND entry = ?", table, rowid);
}

export function storeHistoryValue(sql: HistorySql, table: HistoryTable, rowid: string, column: string, value: string, projection: string): string {
  sql.exec("DELETE FROM history_values WHERE relation = ? AND entry = ? AND field = ?", table, rowid, column);
  const bytes = encoder.encode(value);
  if (bytes.length <= chunkSize) return value;
  if (encoder.encode(projection).length > chunkSize) throw Error("The indexed history projection exceeds one chunk");
  for (let at = 0; at < bytes.length; at += chunkSize) {
    sql.exec("INSERT INTO history_values(relation,entry,field,part,bytes) VALUES (?,?,?,?,?)", table, rowid, column, at / chunkSize, bytes.slice(at, at + chunkSize).buffer);
  }
  return projection;
}

export function readHistoryValue(sql: HistorySql, table: HistoryTable, rowid: string, column: string, physicalValue: string): string {
  const rows = sql.exec<{bytes: ArrayBuffer}>("SELECT bytes FROM history_values WHERE relation = ? AND entry = ? AND field = ? ORDER BY part", table, rowid, column);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parts: string[] = [];
  for (const row of rows) parts.push(decoder.decode(row.bytes, { stream: true }));
  if (!parts.length) return physicalValue;
  parts.push(decoder.decode());
  return parts.join("");
}
