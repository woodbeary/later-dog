import { initializeHistoryMessageIndex } from "../../../../shared/history-message-index.ts";
import type { HistorySql } from "../../../../shared/history-values.ts";

export function initializeHistoryShard(sql: HistorySql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS history_config (singleton INTEGER PRIMARY KEY CHECK (singleton=1),thread_id TEXT NOT NULL,ordinal INTEGER NOT NULL,load_id TEXT,sealed TEXT,fence INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,dirty INTEGER NOT NULL DEFAULT 0)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS history_values (relation TEXT NOT NULL,entry TEXT NOT NULL,field TEXT NOT NULL,part INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(relation,entry,field,part)) WITHOUT ROWID",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS history_sequence (relation TEXT PRIMARY KEY,offset INTEGER NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS history_requests (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS history_results (id TEXT NOT NULL,part INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(id,part)) WITHOUT ROWID",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS messages (thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))",
  );
  sql.exec("CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id)");
  sql.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text,content='messages',content_rowid='rowid',tokenize='unicode61')",
  );
  sql.exec(
    "CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,text) VALUES(new.rowid,new.text); END",
  );
  sql.exec(
    "CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,text) VALUES('delete',old.rowid,old.text); END",
  );
  sql.exec(
    "CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN INSERT INTO messages_fts(messages_fts,rowid,text) VALUES('delete',old.rowid,old.text); INSERT INTO messages_fts(rowid,text) VALUES(new.rowid,new.text); END",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS thread_state (thread_id TEXT PRIMARY KEY,active_leaf_id TEXT)",
  );
  initializeHistoryMessageIndex(sql);
  sql.exec(
    "CREATE TABLE IF NOT EXISTS native_runs (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,started_at INTEGER NOT NULL,json TEXT NOT NULL,event_sequence INTEGER NOT NULL DEFAULT 0,sealed INTEGER NOT NULL DEFAULT 0)",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS history_native_recoverable ON native_runs(id) WHERE json_extract(json,'$.observation')='live' OR json_extract(json,'$.state') IN ('running','waiting','paused')",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS native_runs_thread ON native_runs(thread_id,started_at,id)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS native_run_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,event_id TEXT NOT NULL,at INTEGER NOT NULL,json TEXT NOT NULL,UNIQUE(run_id,event_id))",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS native_run_events_run ON native_run_events(run_id,sequence)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS native_run_items (run_id TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(run_id,id))",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS native_run_items_sequence ON native_run_items(run_id,sequence)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS native_run_retention (thread_id TEXT PRIMARY KEY)",
  );
}
