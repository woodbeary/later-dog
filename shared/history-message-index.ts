import { initializeHistoryCommands } from "./history-command-journal.ts";
import type { HistoryRow } from "./history-migration.ts";
import { readHistoryValue, storeHistoryValue, type HistorySql } from "./history-values.ts";

export function initializeHistoryMessageIndex(sql: HistorySql): void {
  initializeHistoryCommands(sql);
  sql.exec(
    "CREATE TABLE IF NOT EXISTS history_command_results(command TEXT NOT NULL,part INTEGER NOT NULL,result BLOB NOT NULL,PRIMARY KEY(command,part)) WITHOUT ROWID",
  );
  sql.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS history_text_parts USING fts5(text,entry UNINDEXED,tokenize='unicode61')",
  );
}

export function deleteHistoryMessageIndex(sql: HistorySql, rowid?: string): void {
  if (rowid === undefined) sql.exec("DELETE FROM history_text_parts");
  else sql.exec("DELETE FROM history_text_parts WHERE entry=?", rowid);
}

export function messageIndexFields(sql:HistorySql,rowid:string,raw:string) {
  const indexed=JSON.parse(raw);
  return indexed?.extendedIndex ? JSON.parse(readHistoryValue(sql,"messages",rowid,"json",raw)) : indexed;
}

function indexedJson(raw:string):string {
  if(raw.length < 96000)return "";
  const m=JSON.parse(raw);
  let extendedIndex=false;
  const name=(value:unknown)=>{
    if(typeof value!=="string" || value.length<=4096)return value;
    extendedIndex=true;return value.slice(0,4096);
  };
  return JSON.stringify({
    requestPending:m?.requestPending===true,requestCancelled:m?.requestCancelled===true,
    card:m?.card&&{requestType:m.card.requestType==="permission"?"permission":null,answered:m.card.answered==null?null:true,dismissed:m.card.dismissed===true,expired:m.card.expired===true,autoAnswerAt:m.card.autoAnswerAt==null?null:true},
    from:m?.from&&{name:name(m.from.name),botId:name(m.from.botId)},peerAsk:m?.peerAsk&&{name:name(m.peerAsk.name)},tool:m?.tool&&{name:name(m.tool.name)},extendedIndex
  });
}

export function storeHistoryMessageValues(sql: HistorySql, row: HistoryRow): HistoryRow {
  const [id, thread, message, at, role, kind, text, json] = row;
  if (typeof json !== "string") throw Error("Invalid message history row");
  const hasParts =
    [...sql.exec("SELECT 1 FROM history_values WHERE relation='messages' AND entry=? AND field='text' LIMIT 1", id)]
      .length > 0;
  if (hasParts) deleteHistoryMessageIndex(sql, id);
  const physicalText = text == null ? null : storeHistoryValue(sql, "messages", id, "text", text, text.slice(0, 2048));
  if (text == null) sql.exec("DELETE FROM history_values WHERE relation='messages' AND entry=? AND field='text'", id);
  if (text != null && physicalText !== text) {
    for (let start = 0; start < text.length; ) {
      let end = Math.min(start + 65536, text.length);
      if (end < text.length) {
        const boundary = text.slice(end - 2048, end).search(/\s\S*$/u);
        if (boundary >= 0) end = end - 2048 + boundary + 1;
        else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
      }
      sql.exec("INSERT INTO history_text_parts(text,entry) VALUES(?,?)", text.slice(start, end), id);
      start = end;
    }
  }
  return [
    id,
    thread,
    message,
    at,
    role,
    kind,
    physicalText,
    storeHistoryValue(sql, "messages", id, "json", json, indexedJson(json)),
  ];
}
