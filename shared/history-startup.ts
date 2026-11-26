import { readHistoryValue, type HistorySql } from "./history-values.ts";
export interface HistoryStartupFacts {
  waiting: boolean;
  permission: boolean;
  countdown: boolean;
}
const waitingSql = "json_extract(json,'$.needsYou.status')='waiting'";
const permissionSql =
  "kind='options' AND json_extract(json,'$.card.requestType')='permission' AND json_extract(json,'$.card.answered') IS NULL AND COALESCE(json_extract(json,'$.card.dismissed'),0)=0 AND COALESCE(json_extract(json,'$.card.expired'),0)=0";
const countdownSql = "kind='options' AND json_extract(json,'$.card.autoAnswerAt') IS NOT NULL";
export function initializeHistoryStartup(sql: HistorySql): void {
  sql.exec("CREATE INDEX IF NOT EXISTS history_startup_waiting ON messages(thread_id) WHERE " + waitingSql);
  sql.exec("CREATE INDEX IF NOT EXISTS history_startup_permission ON messages(thread_id) WHERE " + permissionSql);
  sql.exec("CREATE INDEX IF NOT EXISTS history_startup_countdown ON messages(thread_id) WHERE " + countdownSql);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS history_startup_large ON history_values(entry) WHERE relation='messages' AND field='json' AND part=0",
  );
}
export function historyStartupFacts(sql: HistorySql, thread: string): HistoryStartupFacts {
  const exists = (predicate: string) => "EXISTS(SELECT 1 FROM messages WHERE thread_id=? AND " + predicate + ")";
  const row = Array.from(
    sql.exec<{ waiting: number; permission: number; countdown: number }>(
      "SELECT " +
        exists(waitingSql) +
        " waiting," +
        exists(permissionSql) +
        " permission," +
        exists(countdownSql) +
        " countdown",
      thread,
      thread,
      thread,
    ),
  )[0];
  const facts = { waiting: !!row.waiting, permission: !!row.permission, countdown: !!row.countdown };
  if (!facts.waiting) {
    for (const r of sql.exec<{ rid: string; raw: string }>(
      "SELECT h.entry rid,m.json raw FROM history_values h JOIN messages m ON m.rowid=CAST(h.entry AS INTEGER) WHERE h.relation='messages' AND h.field='json' AND h.part=0 AND m.thread_id=? AND json_type(m.json,'$.historyIndexVersion') IS NULL",
      thread,
    )) {
      if (JSON.parse(readHistoryValue(sql, "messages", r.rid, "json", r.raw)).needsYou?.status === "waiting") {
        facts.waiting = true;
        break;
      }
    }
  }
  return facts;
}
