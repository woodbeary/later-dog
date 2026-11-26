import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";
import {
  HISTORY_COLUMNS,
  HISTORY_TABLES,
  HISTORY_INTEGER_COLUMNS,
  validHistoryRow,
} from "../../../../../shared/history-migration.ts";

export const digest = (data) => createHash("sha256").update(data).digest("hex");
export const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const children = new Set(["native_run_items", "native_run_events"]);
const controlTables = ["chat_followups", "command_receipts", "memory_files"];

export async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest("hex");
}

export async function checkpoint(source, target) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, target, { rate: 2147483647 });
  } finally {
    db.close();
  }
}

function arrays(db, sql) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  return statement;
}

export function tableExists(db, name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_schema WHERE name=? AND type='table'")
    .get(name);
}

const names = (db, table) =>
  db
    .prepare("PRAGMA table_info(" + quote(table) + ")")
    .all()
    .map((row) => row.name);

export function verifySchema(db) {
  if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok")
    throw Error("SQLite quick_check failed");
  if (!tableExists(db, "messages") || !tableExists(db, "thread_state"))
    throw Error("Unrecognized history schema");
  for (const table of HISTORY_TABLES) {
    if (!tableExists(db, table)) continue;
    const present = names(db, table);
    if (
      present.some((name) => !HISTORY_COLUMNS[table].includes(name)) ||
      HISTORY_COLUMNS[table].some(
        (name) =>
          !present.includes(name) &&
          !(
            table === "native_runs" &&
            ["event_sequence", "sealed"].includes(name)
          ),
      )
    )
      throw Error("Unrecognized history columns in " + table);
    if (children.has(table)) {
      if (
        !tableExists(db, "native_runs") ||
        db
          .prepare(
            "SELECT 1 FROM " +
              table +
              " t WHERE NOT EXISTS (SELECT 1 FROM native_runs r WHERE r.id=t.run_id) LIMIT 1",
          )
          .get()
      )
        throw Error("History child has no native run in " + table);
    }
  }
}

export function threads(db) {
  const owners = HISTORY_TABLES.filter(
    (table) => !children.has(table) && tableExists(db, table),
  );
  const ids = db
    .prepare(
      owners.map((t) => "SELECT DISTINCT thread_id FROM " + t).join(" UNION ") +
        " ORDER BY thread_id",
    )
    .all();
  return ids.map((row) => {
    if (
      typeof row.thread_id !== "string" ||
      !row.thread_id ||
      row.thread_id.includes("\0")
    )
      throw Error("History row has invalid thread identity");
    return row.thread_id;
  });
}

export function* historyRows(db, threadId, table) {
  if (!tableExists(db, table)) return;
  const columns = names(db, table);
  const values = HISTORY_COLUMNS[table].map((name) => {
    if (!columns.includes(name)) return "0";
    const column = "t." + quote(name);
    return HISTORY_INTEGER_COLUMNS[table].includes(name)
      ? column
      : "CASE typeof(" +
          column +
          ") WHEN 'text' THEN CAST(" +
          column +
          " AS BLOB) WHEN 'null' THEN NULL ELSE 0 END";
  });
  const scope = children.has(table)
    ? "t.run_id IN (SELECT id FROM native_runs WHERE thread_id=?)"
    : "t.thread_id=?";
  const result = arrays(
    db,
    "SELECT t.rowid," +
      values.join(",") +
      " FROM " +
      table +
      " t WHERE " +
      scope +
      " ORDER BY t.rowid",
  );
  for (const raw of result.iterate(threadId)) {
    const row = raw.map((v, i) => {
      if (
        i === 0 ||
        HISTORY_INTEGER_COLUMNS[table].includes(HISTORY_COLUMNS[table][i - 1])
      ) {
        if (typeof v !== "bigint") throw Error("Invalid integer in " + table);
        return v.toString();
      }
      if (v === null) return null;
      if (!(v instanceof Uint8Array))
        throw Error("Invalid text storage in " + table);
      return utf8.decode(v);
    });
    if (!validHistoryRow(table, row))
      throw Error("Invalid historical row in " + table);
    yield row;
  }
}

export function controlProof(db) {
  const result = {};
  for (const table of controlTables) {
    if (!tableExists(db, table)) continue;
    const cols = names(db, table);
    const fields = cols
      .map(quote)
      .map((c) => "typeof(" + c + "),hex(CAST(" + c + " AS BLOB))");
    const hash = createHash("sha256");
    let count = 0;
    for (const row of arrays(
      db,
      "SELECT CAST(rowid AS TEXT)," +
        fields.join(",") +
        " FROM " +
        table +
        " ORDER BY rowid",
    ).iterate()) {
      hash.update(JSON.stringify(row) + "\n");
      count++;
    }
    result[table] = { count, sha256: hash.digest("hex") };
  }
  return result;
}

export function eventSequence(db) {
  if (!tableExists(db, "sqlite_sequence")) return null;
  return (
    db
      .prepare(
        "SELECT cast(seq AS TEXT) AS value FROM sqlite_sequence WHERE name='native_run_events'",
      )
      .get()?.value ?? null
  );
}

export function setSequenceAtLeast(db, value) {
  if (value === null || !tableExists(db, "native_run_events")) return;
  const before = eventSequence(db);
  if (before === null)
    db.prepare(
      "INSERT INTO sqlite_sequence(name,seq) VALUES('native_run_events',?)",
    ).run(BigInt(value));
  else if (BigInt(before) < BigInt(value))
    db.prepare(
      "UPDATE sqlite_sequence SET seq=? WHERE name='native_run_events'",
    ).run(BigInt(value));
}

export function insertRow(db, table) {
  const cols = HISTORY_COLUMNS[table];
  const keys = table === "native_run_events" ? cols : ["rowid", ...cols];
  const insert = db.prepare(
    "INSERT INTO " +
      table +
      " (" +
      keys.map(quote).join(",") +
      ") VALUES (" +
      keys.map(() => "?").join(",") +
      ")",
  );
  return (row) => {
    const vals = row.map((v, i) =>
      i === 0 || HISTORY_INTEGER_COLUMNS[table].includes(cols[i - 1])
        ? BigInt(v)
        : v,
    );
    insert.run(...(table === "native_run_events" ? vals.slice(1) : vals));
  };
}

export function clearHistory(db) {
  const triggers = db
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='messages' AND name IN ('messages_fts_ai','messages_fts_ad','messages_fts_au')",
    )
    .all();
  for (const t of triggers) db.exec("DROP TRIGGER " + quote(t.name));
  for (const t of HISTORY_TABLES)
    if (tableExists(db, t)) db.exec("DELETE FROM " + t);
  if (tableExists(db, "messages_fts"))
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  for (const t of triggers) db.exec(t.sql);
}

export function checkIndexes(db) {
  for (const fts of ["messages_fts", "memory_fts"])
    if (tableExists(db, fts))
      db.exec(
        "INSERT INTO " + fts + "(" + fts + ",rank) VALUES('integrity-check',1)",
      );
}

export function validateImportRow(thread, table, row, last) {
  if (
    !validHistoryRow(table, row) ||
    (last !== null && BigInt(row[0]) <= BigInt(last))
  )
    throw Error("Invalid row or order in " + table);
  const index = HISTORY_COLUMNS[table].indexOf("thread_id");
  if (index >= 0 && row[index + 1] !== thread)
    throw Error("Cross-thread history row");
}
