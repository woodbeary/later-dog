import { createHash } from "node:crypto";
import { DurableObject } from "cloudflare:workers";
import {
  HISTORY_COLUMNS,
  HISTORY_INTEGER_COLUMNS,
  HISTORY_TABLES,
  historyInteger,
  historyRowLine,
  historyThreadProofBytes,
  validHistoryRow,
  type HistoryRow,
  type HistoryTable,
  type HistoryTableProofs,
} from "../../../../shared/history-migration.ts";
import {
  readHistoryValue,
  storeHistoryValue,
} from "../../../../shared/history-values.ts";
import {
  executeHistoryOperation,
  historyOperationWrites,
  type HistoryOperation,
} from "../../../../shared/history-shard-operations.ts";
import {
  deleteHistoryMessageIndex,
  storeHistoryMessageValues,
} from "../../../../shared/history-message-operations.ts";
import { nativeHistoryProjection } from "../../../../shared/history-native-operations.ts";
import { initializeHistoryShard } from "./history-schema.ts";
import type {
  ImportCommand,
  ImportedPage,
  PageCommand,
  ShardAddress,
} from "./history-routing.ts";

type Config = {
  thread_id: string;
  ordinal: number;
  load_id: string | null;
  sealed: string | null;
  fence: number;
  dirty: number;
};
type Grant = ShardAddress & { revision: number; base: string };
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function tableName(table: HistoryTable): HistoryTable {
  if (!HISTORY_TABLES.includes(table)) throw Error("Unknown history table");
  return table;
}
function sourceColumns(table: HistoryTable): string {
  const integers = HISTORY_INTEGER_COLUMNS[table];
  return [
    "CAST(rowid AS TEXT)",
    ...HISTORY_COLUMNS[table].map((column) =>
      integers.includes(column) ? "CAST(" + column + " AS TEXT)" : column,
    ),
  ].join(",");
}

export class HistoryShard extends DurableObject<unknown> {
  private get sql() {
    return this.ctx.storage.sql;
  }
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    initializeHistoryShard(this.sql);
  }
  private configure(grant: Grant): Config {
    let c = this.sql
      .exec<Config>(
        "SELECT thread_id,ordinal,load_id,sealed,fence,dirty FROM history_config WHERE singleton=1",
      )
      .toArray()[0];
    if (!c && grant.ordinal)
      c = this.sql
        .exec<Config>(
          "INSERT INTO history_config(singleton,thread_id,ordinal) VALUES(1,?,?) RETURNING thread_id,ordinal,load_id,sealed,fence,dirty",
          grant.threadId,
          grant.ordinal,
        )
        .one();
    if (
      c &&
      (c.thread_id !== grant.threadId ||
        (grant.ordinal && c.ordinal !== grant.ordinal))
    )
      throw Error("History shard identity changed");
    return (
      c ?? {
        thread_id: grant.threadId,
        ordinal: 0,
        load_id: null,
        sealed: null,
        fence: 0,
        dirty: 0,
      }
    );
  }
  private logical(table: HistoryTable, raw: (string | null)[]): HistoryRow {
    const row = raw as [string, ...(string | null)[]];
    HISTORY_COLUMNS[table].forEach((column, i) => {
      if (row[i + 1] !== null && (column === "text" || column === "json"))
        row[i + 1] = readHistoryValue(
          this.sql,
          table,
          row[0],
          column,
          row[i + 1]!,
        );
    });
    return row;
  }
  private rows(
    table: HistoryTable,
    after?: string,
    limit?: number,
  ): IterableIterator<(string | null)[]> {
    tableName(table);
    if (after !== undefined && !historyInteger(after))
      throw Error("Invalid history cursor");
    const where =
      after === undefined ? "" : " WHERE rowid > CAST(? AS INTEGER)";
    const end = limit === undefined ? "" : " LIMIT ?";
    const params: (number | string)[] = after === undefined ? [] : [after];
    if (limit !== undefined) params.push(limit);
    return this.sql
      .exec(
        "SELECT " +
          sourceColumns(table) +
          " FROM " +
          table +
          where +
          " ORDER BY rowid" +
          end,
        ...params,
      )
      .raw<(string | null)[]>();
  }
  page(grant: Grant, req: PageCommand): ImportedPage {
    this.configure(grant);
    const limit = req.limit ?? 256;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1024)
      throw Error("Invalid history export page size");
    const rows: HistoryRow[] = [];
    let bytes = 0;
    for (const raw of this.rows(req.table, req.after, limit + 1)) {
      if (rows.length && (rows.length === limit || bytes >= 512 * 1024))
        return { rows, next: rows.at(-1)![0] };
      const row = this.logical(req.table, raw);
      rows.push(row);
      bytes += historyRowLine(row).byteLength;
    }
    return { rows, next: null };
  }
  private verifyThread(
    thread: string,
    table: HistoryTable,
    row: HistoryRow,
  ): void {
    const cols: readonly string[] = HISTORY_COLUMNS[table];
    const i = cols.indexOf("thread_id");
    if (i >= 0 && row[i + 1] !== thread)
      throw Error("Row belongs to another history thread");
    const parent = cols.indexOf("run_id");
    if (
      parent >= 0 &&
      !this.sql
        .exec(
          "SELECT 1 FROM native_runs WHERE id=? AND thread_id=?",
          row[parent + 1],
          thread,
        )
        .toArray().length
    )
      throw Error("History row has no run in this shard");
  }
  private insertRow(
    thread: string,
    table: HistoryTable,
    row: HistoryRow,
  ): void {
    if (!validHistoryRow(table, row))
      throw Error("Invalid imported history row");
    const prior = this.sql
      .exec(
        "SELECT " +
          sourceColumns(table) +
          " FROM " +
          table +
          " WHERE rowid=CAST(? AS INTEGER)",
        row[0],
      )
      .raw<(string | null)[]>()
      .next();
    if (!prior.done) {
      if (
        JSON.stringify(this.logical(table, prior.value)) !== JSON.stringify(row)
      )
        throw Error("A different history row already occupies this position");
      return;
    }
    this.verifyThread(thread, table, row);
    let physical = row;
    if (table === "messages")
      physical = storeHistoryMessageValues(this.sql, row);
    else if (
      table === "native_runs" ||
      table === "native_run_events" ||
      table === "native_run_items"
    ) {
      const cols: readonly string[] = HISTORY_COLUMNS[table];
      const i = cols.indexOf("json") + 1;
      const value = row[i]!;
      if (new TextEncoder().encode(value).length > 384 * 1024) {
        const fields: [string, ...(string | null)[]] = [...row];
        fields[i] = storeHistoryValue(
          this.sql,
          table,
          row[0],
          "json",
          value,
          nativeHistoryProjection(table, "json", value),
        );
        physical = fields;
      }
    }
    const columns: readonly string[] = HISTORY_COLUMNS[table];
    const names =
      table === "native_run_events" ? columns : ["rowid", ...columns];
    const values = table === "native_run_events" ? physical.slice(1) : physical;
    this.sql.exec(
      "INSERT INTO " +
        table +
        "(" +
        names.join(",") +
        ") VALUES(" +
        names.map(() => "?").join(",") +
        ")",
      ...values,
    );
  }
  private proofs(threadId: string) {
    const tables = {} as HistoryTableProofs;
    for (const table of HISTORY_TABLES) {
      const hash = createHash("sha256");
      let count = 0,
        bytes = 0;
      for (const physical of this.rows(table)) {
        const line = historyRowLine(this.logical(table, physical));
        count++;
        bytes += line.length;
        hash.update(line);
      }
      tables[table] = { count, bytes, sha256: hash.digest("hex") };
    }
    return {
      v: 1 as const,
      threadId,
      tables,
      sha256: digest(historyThreadProofBytes(threadId, tables)),
    };
  }
  importRows(grant: Grant, command: ImportCommand) {
    return this.ctx.storage.transactionSync(() => {
      const state = this.configure(grant);
      if (
        !grant.ordinal ||
        grant.revision <= state.fence ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(command.loadId)
      )
        throw Error("History import is fenced");
      if (command.op === "reset") {
        if (state.load_id === command.loadId) return { loadId: command.loadId };
        if (state.load_id !== command.expectedLoadId)
          throw Error("History import lease changed");
        for (const table of [...HISTORY_TABLES].reverse())
          this.sql.exec("DELETE FROM " + table);
        deleteHistoryMessageIndex(this.sql);
        this.sql.exec("DELETE FROM history_values");
        this.sql.exec(
          "UPDATE history_config SET load_id=?,sealed=NULL WHERE singleton=1",
          command.loadId,
        );
        return { loadId: command.loadId };
      }
      if (state.load_id !== command.loadId)
        throw Error("History import lease changed");
      if (command.op === "seal") {
        const proof = this.proofs(grant.threadId);
        if (
          command.proof?.v !== 1 ||
          command.proof.threadId !== grant.threadId ||
          command.proof.sha256 !== proof.sha256 ||
          digest(
            historyThreadProofBytes(grant.threadId, command.proof.tables),
          ) !== proof.sha256
        )
          throw Error("History shard checksum mismatch");
        this.sql.exec(
          "UPDATE history_config SET sealed=? WHERE singleton=1",
          proof.sha256,
        );
        let maximum = 0n;
        for (const table of HISTORY_TABLES) {
          const high = BigInt(
            this.sql
              .exec<{
                id: string;
              }>("SELECT CAST(rowid AS TEXT) id FROM " + table + " ORDER BY rowid DESC LIMIT 1")
              .toArray()[0]?.id ?? "0",
          );
          if (high > maximum) maximum = high;
        }
        return { sha256: proof.sha256, maximum: String(maximum) };
      }
      if (state.sealed) throw Error("This history import is sealed");
      const table = tableName(command.table);
      for (let i = 0; i < command.rows.length; i++) {
        const row = command.rows[i];
        if (i && BigInt(command.rows[i - 1][0]) >= BigInt(row[0]))
          throw Error("History import order changed");
        this.insertRow(grant.threadId, table, row);
      }
      return { count: command.rows.length };
    });
  }
  async importStream(
    grant: Grant,
    command: { loadId: string; table: HistoryTable },
    body: ReadableStream<Uint8Array>,
  ) {
    const row = await new Response(body).json<HistoryRow>();
    return this.importRows(grant, {
      op: "import",
      loadId: command.loadId,
      table: command.table,
      rows: [row],
    });
  }
  pageStream(grant: Grant, command: PageCommand): ReadableStream<Uint8Array> {
    return new Blob([JSON.stringify(this.page(grant, command))]).stream();
  }
  exportCheck(grant: Grant) {
    this.configure(grant);
    const version = this.sql
      .exec<{
        version: number;
      }>("SELECT version FROM history_config WHERE singleton=1")
      .one().version;
    const hasUserMessage =
      this.sql
        .exec("SELECT 1 FROM messages WHERE role='user' LIMIT 1")
        .toArray().length > 0;
    return {
      threadId: grant.threadId,
      version,
      hasUserMessage,
      ...this.watermark(grant),
    };
  }
  exportPage(grant: Grant, version: number, command: PageCommand) {
    if (this.exportCheck(grant).version !== version)
      throw Error("History changed during portable export");
    return this.pageStream(grant, command);
  }
  shardStatus(grant: Grant) {
    const c = this.configure(grant);
    return { loadId: c.load_id, sha256: c.sealed };
  }
  watermark(grant: Grant) {
    const c = this.configure(grant);
    const last =
      this.sql
        .exec<{
          value: string;
        }>(
          "SELECT CAST(seq AS TEXT) value FROM sqlite_sequence WHERE name='native_run_events'",
        )
        .toArray()[0]?.value ?? "0";
    const offset = this.sql
      .exec<{
        offset: number;
      }>(
        "SELECT offset FROM history_sequence WHERE relation='native_run_events'",
      )
      .toArray()[0]?.offset;
    const reserved = offset
      ? BigInt(grant.base) + BigInt(c.ordinal) * 2n ** 30n + BigInt(offset)
      : 0n;
    return {
      nativeEventSequence: String(
        reserved > BigInt(last) ? reserved : BigInt(last),
      ),
    };
  }
  fence(grant: Grant): string | null {
    const c = this.configure(grant);
    if (!c.ordinal || grant.revision < c.fence)
      throw Error("Stale history fence");
    return this.ctx.storage.transactionSync(() => {
      const proof =
        c.dirty || (!c.load_id && !c.sealed)
          ? this.proofs(grant.threadId).sha256
          : c.sealed;
      this.sql.exec(
        "UPDATE history_config SET fence=?,sealed=?,dirty=0 WHERE singleton=1",
        grant.revision,
        proof,
      );
      return proof;
    });
  }
  private allocate(grant: Grant, table: HistoryTable): string {
    if (!grant.ordinal) throw Error("History thread is unregistered");
    const { offset } = this.sql
      .exec<{
        offset: number;
      }>(
        "INSERT INTO history_sequence(relation,offset) VALUES(?,1) ON CONFLICT(relation) DO UPDATE SET offset=offset+1 RETURNING offset",
        tableName(table),
      )
      .one();
    const value =
      BigInt(grant.base) + BigInt(grant.ordinal) * 2n ** 30n + BigInt(offset);
    if (offset >= 2 ** 30 || value >= 2n ** 63n)
      throw Error("History shard rowid allocation exceeded its range");
    return String(value);
  }
  execute(
    grant: Grant,
    mode: "dual" | "remote",
    operation: HistoryOperation,
    requestId?: string,
  ): Response {
    const reply = this.ctx.storage.transactionSync(() => {
      const c = this.configure(grant);
      const write = historyOperationWrites(operation);
      if (
        grant.revision <= c.fence ||
        (mode === "dual" && (!c.sealed || write))
      )
        throw Error("History shard is held or still importing");
      if (!write)
        return {
          result: (executeHistoryOperation(
            this.sql,
            grant.threadId,
            operation,
            () => {
              throw Error("A history query attempted to allocate a row");
            },
          ) ?? null) as unknown,
        };
      if (
        typeof requestId !== "string" ||
        !requestId.length ||
        requestId.length > 512 ||
        !grant.ordinal
      )
        throw Error("A history write requires a stable request ID");
      const fingerprint = digest(JSON.stringify(operation));
      const old = this.sql
        .exec<{
          fingerprint: string;
        }>("SELECT fingerprint FROM history_requests WHERE id=?", requestId)
        .toArray()[0];
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw Error("A different history operation reused this request ID");
        const decoder = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        });
        const parts = this.sql.exec<{ bytes: ArrayBuffer }>(
          "SELECT bytes FROM history_results WHERE id=? ORDER BY part",
          requestId,
        );
        return {
          result: JSON.parse(
            Array.from(parts, (row) =>
              decoder.decode(row.bytes, { stream: true }),
            ).join("") + decoder.decode(),
          ) as unknown,
        };
      }
      const result =
        executeHistoryOperation(this.sql, grant.threadId, operation, (table) =>
          this.allocate(grant, table),
        ) ?? null;
      const bytes = new TextEncoder().encode(JSON.stringify(result));
      this.sql.exec(
        "INSERT INTO history_requests(id,fingerprint) VALUES(?,?)",
        requestId,
        fingerprint,
      );
      for (let at = 0; at < bytes.length; at += 384 * 1024)
        this.sql.exec(
          "INSERT INTO history_results(id,part,bytes) VALUES(?,?,?)",
          requestId,
          at / (384 * 1024),
          bytes.slice(at, at + 384 * 1024).buffer,
        );
      this.sql.exec(
        "UPDATE history_config SET sealed=NULL,dirty=1,version=version+1 WHERE singleton=1",
      );
      return { result };
    });
    return Response.json(reply);
  }
}
