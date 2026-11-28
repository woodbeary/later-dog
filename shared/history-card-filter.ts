import { readHistoryValue, type HistorySql } from "./history-values.ts";
export const historyUnansweredCardSql =
  "json_type(messages.json,'$.card')='object' AND COALESCE(json_extract(messages.json,'$.card.dismissed'),0)=0 AND (COALESCE(json_extract(messages.json,'$.card.answered'),'') IN ('',0) OR EXISTS(SELECT 1 FROM history_values WHERE relation='messages' AND entry=CAST(messages.rowid AS TEXT) AND field='json'))";

export function historyHasUnansweredCards(
  sql: HistorySql,
  thread: string,
): boolean {
  for (const row of sql.exec<{ rid: string; json: string }>(
    "SELECT CAST(rowid AS TEXT) rid,json FROM messages WHERE thread_id=? AND " +
      historyUnansweredCardSql,
    thread,
  )) {
    const card = JSON.parse(
      readHistoryValue(sql, "messages", row.rid, "json", row.json),
    ).card;
    if (card && !card.answered && !card.dismissed) return true;
  }
  return false;
}
