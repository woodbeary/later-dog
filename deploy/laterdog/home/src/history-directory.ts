import { DurableObject } from "cloudflare:workers";
import {
  requireGeneration,
  requireThread,
  type HistoryMode,
  type Placement,
  type ShardAddress,
  type ThreadPage,
} from "./history-routing.ts";

type ModeRow = {
  mode: HistoryMode;
  generation: string | null;
  revision: number;
};
type ThreadRow = {
  thread: string;
  ordinal: number;
  proof: string | null;
  fenced: number;
};

export class HistoryDirectory extends DurableObject<unknown> {
  private get sql() {
    return this.ctx.storage.sql;
  }
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS placement (singleton INTEGER PRIMARY KEY,mode TEXT NOT NULL,generation TEXT,revision INTEGER NOT NULL)",
    );
    this.sql.exec("INSERT OR IGNORE INTO placement VALUES(1,'legacy',NULL,0)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS generations (name TEXT PRIMARY KEY,activated INTEGER NOT NULL DEFAULT 0)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS shards (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,generation TEXT NOT NULL,thread TEXT NOT NULL,proof TEXT,fenced INTEGER NOT NULL DEFAULT 0,UNIQUE(generation,thread))",
    );
  }
  status(): Placement {
    return this.sql
      .exec<ModeRow>(
        "SELECT mode,generation,revision FROM placement WHERE singleton=1",
      )
      .one();
  }
  begin(generation: string, expectedRevision: number): Placement {
    requireGeneration(generation);
    return this.ctx.storage.transactionSync(() => {
      const p = this.status();
      if (
        p.mode === "dual" &&
        p.generation === generation &&
        p.revision === expectedRevision + 1
      )
        return p;
      if (p.mode !== "legacy" || p.revision !== expectedRevision)
        throw Error("History placement changed before preparation");
      this.sql.exec("INSERT INTO generations(name) VALUES(?)", generation);
      this.sql.exec(
        "UPDATE placement SET mode='dual',generation=?,revision=revision+1 WHERE singleton=1",
        generation,
      );
      return this.status();
    });
  }
  open(
    generation: string,
    threadId: string,
    purpose: "stage" | "read" | "write" | "export",
  ): ShardAddress & { revision: number; mode: "remote" | "dual" } {
    requireGeneration(generation);
    requireThread(threadId);
    const p = this.status();
    if (p.generation !== generation) throw Error("History generation changed");
    if (purpose === "stage" && p.mode !== "dual")
      throw Error("History import is closed");
    if (purpose === "write" && p.mode !== "remote")
      throw Error("History shard writes are held");
    if (purpose === "read" && p.mode !== "remote" && p.mode !== "dual")
      throw Error("History shard reads are held");
    const create = purpose === "stage" || purpose === "write";
    let row = this.sql
      .exec<ThreadRow>(
        "SELECT ordinal,thread,proof,fenced FROM shards WHERE generation=? AND thread=?",
        generation,
        threadId,
      )
      .toArray()[0];
    if (!row && create) {
      row = this.sql
        .exec<ThreadRow>(
          "INSERT INTO shards(generation,thread) VALUES(?,?) RETURNING ordinal,thread,proof,fenced",
          generation,
          threadId,
        )
        .one();
      if (row.ordinal > 8387583) throw Error("History rowid ranges exhausted");
    }
    return {
      generation,
      threadId,
      ordinal: row?.ordinal ?? 0,
      revision: p.revision,
      mode: p.mode === "remote" ? "remote" : "dual",
    };
  }
  list(generation: string, after?: string, limit = 32): ThreadPage {
    if (this.status().generation !== generation)
      throw Error("History generation changed");
    if (!Number.isInteger(limit) || limit < 1 || limit > 256)
      throw Error("Invalid history page size");
    const rows = this.sql
      .exec<{
        thread: string;
      }>("SELECT thread FROM shards WHERE generation=? AND thread>? ORDER BY thread LIMIT ?", generation, after ?? "", limit + 1)
      .toArray();
    const threads = rows.slice(0, limit).map((row) => row.thread);
    return { threads, next: rows.length > limit ? threads.at(-1)! : null };
  }
  recordProof(
    generation: string,
    threadId: string,
    revision: number,
    proof: string | null,
  ): void {
    const p = this.status();
    if (
      p.generation !== generation ||
      p.mode !== "dual" ||
      p.revision !== revision
    )
      throw Error("Import placement changed");
    this.sql.exec(
      "UPDATE shards SET proof=? WHERE generation=? AND thread=?",
      proof,
      generation,
      threadId,
    );
  }
  abandon(generation: string, expectedRevision: number): Placement {
    const p = this.status();
    if (p.mode === "legacy" && p.revision === expectedRevision + 1) return p;
    if (
      p.generation !== generation ||
      p.revision !== expectedRevision ||
      !["held", "dual"].includes(p.mode) ||
      this.sql
        .exec<{
          activated: number;
        }>("SELECT activated FROM generations WHERE name=?", generation)
        .one().activated
    )
      throw Error("Serving history requires a verified reverse");
    this.sql.exec(
      "UPDATE placement SET mode='legacy',generation=NULL,revision=revision+1 WHERE singleton=1",
    );
    return this.status();
  }
  hold(generation: string, expectedRevision: number): Placement {
    const p = this.status();
    if (
      p.generation === generation &&
      p.mode === "held" &&
      p.revision === expectedRevision + 1
    )
      return p;
    if (
      p.generation !== generation ||
      p.revision !== expectedRevision ||
      !["dual", "remote"].includes(p.mode)
    )
      throw Error("History placement changed before hold");
    this.sql.exec(
      "UPDATE placement SET mode='held',revision=revision+1 WHERE singleton=1",
    );
    return this.status();
  }
  fenced(
    generation: string,
    thread: string,
    revision: number,
    proof: string | null,
  ): void {
    const p = this.status();
    if (
      p.mode !== "held" ||
      p.generation !== generation ||
      p.revision !== revision
    )
      throw Error("History hold changed");
    this.sql.exec(
      "UPDATE shards SET fenced=?,proof=? WHERE generation=? AND thread=?",
      revision,
      proof,
      generation,
      thread,
    );
  }
  barrier(generation: string, revision: number) {
    const p = this.status();
    if (
      p.mode !== "held" ||
      p.generation !== generation ||
      p.revision !== revision
    )
      throw Error("History hold changed");
    const { threads, pending } = this.sql
      .exec<{
        threads: number;
        pending: number;
      }>("SELECT COUNT(*) threads,COUNT(*) FILTER (WHERE fenced<>?) pending FROM shards WHERE generation=?", revision, generation)
      .one();
    return { held: pending === 0, threads };
  }
  finish(
    generation: string,
    revision: number,
    mode: "remote" | "legacy",
    expected: [string, string][],
  ): Placement {
    const p = this.status();
    if (
      p.mode === mode &&
      p.revision === revision + 1 &&
      p.generation === (mode === "legacy" ? null : generation)
    )
      return p;
    if (
      p.mode !== "held" ||
      p.generation !== generation ||
      p.revision !== revision
    )
      throw Error("History must be held for activation");
    const rows = this.sql
      .exec<ThreadRow>(
        "SELECT thread,ordinal,proof,fenced FROM shards WHERE generation=? ORDER BY thread",
        generation,
      )
      .toArray();
    const proofs = new Map(expected);
    if (
      proofs.size !== rows.length ||
      expected.length !== rows.length ||
      !rows.every(
        (row) =>
          row.fenced === revision &&
          proofs.has(row.thread) &&
          /^[a-f0-9]{64}$/.test(proofs.get(row.thread)!) &&
          proofs.get(row.thread) === row.proof,
      )
    )
      throw Error(
        "The frozen history inventory does not match activation evidence",
      );
    return this.ctx.storage.transactionSync(() => {
      if (mode === "remote")
        this.sql.exec(
          "UPDATE generations SET activated=1 WHERE name=?",
          generation,
        );
      this.sql.exec(
        "UPDATE placement SET mode=?,generation=?,revision=revision+1 WHERE singleton=1",
        mode,
        mode === "legacy" ? null : generation,
      );
      return this.status();
    });
  }
}
