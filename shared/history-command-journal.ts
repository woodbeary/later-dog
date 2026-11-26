import { historyInteger } from "./history-migration.ts";
import { receiptDigest } from "./history-receipt.ts";
import type { HistorySql } from "./history-values.ts";
import type { HistoryOperation } from "./history-shard-types.ts";

export type HistoryCommandRow = {
  sequence: string;
  rowid: string;
  kind: string;
  key: string;
  at: string;
  resultRef: string;
};
export type HistoryCommandPage = { rows: HistoryCommandRow[]; next: string | null };
const columns = "CAST(sequence AS TEXT) sequence,position AS rowid,kind,command_key AS key,at,result_ref AS resultRef";
export function initializeHistoryCommands(sql: HistorySql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS history_command_journal(sequence INTEGER PRIMARY KEY AUTOINCREMENT,identity TEXT NOT NULL UNIQUE,position TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,command_key TEXT NOT NULL,at TEXT NOT NULL,result_ref TEXT NOT NULL,UNIQUE(kind,command_key))",
  );
}
export function historyCommandHead(sql: HistorySql): string | null {
  return (
    [
      ...sql.exec<{ cursor: string | null }>("SELECT CAST(MAX(sequence) AS TEXT) cursor FROM history_command_journal"),
    ][0].cursor ?? null
  );
}
export function historyCommandPage(sql: HistorySql, o: HistoryOperation): HistoryCommandPage {
  const after = o.after ?? "0",
    limit = o.limit ?? 64;
  if (
    !historyInteger(after) ||
    Number(after) < 0 ||
    !Number.isInteger(limit) ||
    typeof limit !== "number" ||
    limit < 1 ||
    limit > 256
  )
    throw Error("Invalid command history page");
  const rows = [
    ...sql.exec<HistoryCommandRow>(
      "SELECT " + columns + " FROM history_command_journal WHERE sequence>CAST(? AS INTEGER) ORDER BY sequence LIMIT ?",
      after,
      limit + 1,
    ),
  ];
  const more = rows.length > limit;
  if (more) rows.pop();
  return { rows, next: more ? rows.at(-1)!.sequence : null };
}
export function acceptedHistoryCommand(sql: HistorySql, identity: string): HistoryCommandRow | undefined {
  return [
    ...sql.exec<HistoryCommandRow>("SELECT " + columns + " FROM history_command_journal WHERE identity=?", identity),
  ][0];
}
export function journalHistoryCommand(sql: HistorySql, o: HistoryOperation): HistoryCommandRow {
  if (
    typeof o.key !== "string" ||
    typeof o.kind !== "string" ||
    typeof o.commandKey !== "string" ||
    !historyInteger(o.rowid) ||
    !historyInteger(o.at) ||
    typeof o.result !== "string"
  )
    throw Error("Conversation command metadata is invalid");
  receiptDigest(o.result);
  sql.exec(
    "INSERT INTO history_command_journal(identity,position,kind,command_key,at,result_ref) VALUES(?,?,?,?,?,?)",
    o.key,
    o.rowid,
    o.kind,
    o.commandKey,
    o.at,
    o.result,
  );
  return acceptedHistoryCommand(sql, o.key)!;
}
