import { HistoryReceiptPacks, type ReceiptPack } from "./history-receipt-packs.ts";
import { HistoryErasure } from "./history-erasure.ts";
import { getReceipt, putReceipt, receiptBatch, type ReceiptBatch } from "./history-receipts.ts";
import type { HistoryShard } from "./history-shard.ts";
import { requireTenant, shardName } from "./history-routing.ts";
import {
  HistoryRecovery,
  type RecoveryQuery,
  type RecoveryState,
} from "./history-recovery.ts";
import {
  RestoreJournal,
  type RestoreKey,
  type HistoryGrant,
} from "./history-restore.ts";
import { DurableObject } from "cloudflare:workers";
import {
  requireGeneration,
  requireThread,
  type HistoryMode,
  type Placement,
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

type Environment = { RECEIPTS: R2Bucket; THREADS: DurableObjectNamespace<HistoryShard> };
export class HistoryDirectory extends DurableObject<Environment> {
  private readonly packs: HistoryReceiptPacks;
  private readonly erasure: HistoryErasure;
  private readonly recoveryIndex: HistoryRecovery;
  private get recovery() {
    this.erasure.assertServing();
    return this.recoveryIndex;
  }
  private readonly restoreJournal: RestoreJournal;
  private get restores() {
    this.erasure.assertServing();
    return this.restoreJournal;
  }
  private get sql() {
    this.erasure.assertServing();
    return this.ctx.storage.sql;
  }
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    this.erasure = new HistoryErasure(ctx.storage);
    this.packs = new HistoryReceiptPacks(ctx.storage, env.RECEIPTS);
    const sql = ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS placement (singleton INTEGER PRIMARY KEY,mode TEXT NOT NULL,generation TEXT,revision INTEGER NOT NULL)",
    );
    this.restoreJournal = new RestoreJournal(sql);
    this.recoveryIndex = new HistoryRecovery(sql);
    sql.exec("INSERT OR IGNORE INTO placement VALUES(1,'legacy',NULL,0)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS generations (name TEXT PRIMARY KEY,activated INTEGER NOT NULL DEFAULT 0)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS shards (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,generation TEXT NOT NULL,thread TEXT NOT NULL,proof TEXT,fenced INTEGER NOT NULL DEFAULT 0,UNIQUE(generation,thread))",
    );
  }
  permitsPhysical(generation: string) {
    if (!this.erasure.serving()) return false;
    return (
      this.sql
        .exec(
          "SELECT 1 FROM generations WHERE name=? UNION ALL SELECT 1 FROM history_restores WHERE target=? LIMIT 1",
          generation,
          generation,
        )
        .toArray().length > 0
    );
  }
  eraseHome(stable: string, token: string) {
    this.checkTenant(stable);
    return this.erasure.batch(
      stable,
      token,
      this.env.RECEIPTS,
      ({ generation, thread }) =>
        this.env.THREADS.getByName(
          shardName(stable, generation, thread),
        ).eraseHome(),
    );
  }
  reopenHome(stable: string, token: string) {
    this.checkTenant(stable);
    this.erasure.reopen(token);
  }
  private checkTenant(stable: string) {
    requireTenant(stable);
    if (this.ctx.id.name !== stable)
      throw Error("History directory identity changed");
  }
  private checkReceipt(stable: string, generation: string, admin: boolean) {
    this.checkTenant(stable);
    const state = this.status();
    if (state.generation !== generation || (!admin && state.mode !== "remote"))
      throw Error("History receipt generation changed");
  }
  putReceiptPack(
    stable: string,
    generation: string,
    pack: ReceiptPack,
    body: ReadableStream<Uint8Array>,
  ) {
    const check = () => {
      this.checkReceipt(stable, generation, true);
      if (this.status().mode !== "dual")
        throw Error("History receipt pack import is closed");
    };
    check();
    return this.erasure.admitReceipt(() =>
      this.packs.publish(stable, generation, pack, body, check),
    );
  }
  async readReceipt(
    stable: string,
    generation: string,
    hash: string,
    admin: boolean,
  ) {
    this.checkReceipt(stable, generation, admin);
    const body =
      (await this.packs.read(stable, generation, hash)) ??
      (await getReceipt(this.env.RECEIPTS, stable, generation, hash));
    this.checkReceipt(stable, generation, admin);
    const reader = body.getReader();
    const permitted = () => this.checkReceipt(stable, generation, admin);
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          permitted();
          const part = await reader.read();
          permitted();
          if (part.done) controller.close();
          else controller.enqueue(part.value);
        } catch (error) {
          await reader.cancel().catch(() => {});
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
  }
  async writeReceipt(
    stable: string,
    generation: string,
    hash: string,
    body: ReadableStream<Uint8Array>,
    admin: boolean,
  ) {
    this.checkReceipt(stable, generation, admin);
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    return this.erasure.admitReceipt(async () => {
      this.checkReceipt(stable, generation, admin);
      return putReceipt(this.env.RECEIPTS, stable, generation, hash, bytes);
    });
  }
  receipts(stable: string, batch: ReceiptBatch, admin: boolean) {
    return this.erasure.admitReceipt(async () => {
      this.checkReceipt(stable, batch.generation, admin);
      const result = await receiptBatch(
        this.env.RECEIPTS,
        stable,
        batch,
        this.packs.batch(stable, batch.generation),
      );
      this.checkReceipt(stable, batch.generation, admin);
      return result;
    });
  }
  status(): Placement {
    return this.sql
      .exec<ModeRow>(
        "SELECT mode,generation,revision FROM placement WHERE singleton=1",
      )
      .one();
  }
  private reserveEventSequence(
    generation: string,
    sequence?: string,
    finalized = false,
  ) {
    if (sequence === undefined) return;
    if (
      typeof sequence !== "string" ||
      !/^(0|[1-9][0-9]{0,18})$/.test(sequence) ||
      BigInt(sequence) >= 2n ** 63n
    )
      throw Error("Invalid native history event sequence");
    if (
      finalized &&
      BigInt(sequence) >= BigInt(this.restores.range(generation))
    )
      throw Error("The restore event range is already sealed");
    this.restores.reserve(generation, sequence);
  }
  begin(
    generation: string,
    expectedRevision: number,
    eventSequence?: string,
  ): Placement {
    requireGeneration(generation);
    this.erasure.allowGeneration(generation);
    return this.ctx.storage.transactionSync(() => {
      const p = this.status();
      if (
        p.mode === "dual" &&
        p.generation === generation &&
        p.revision === expectedRevision + 1
      ) {
        this.reserveEventSequence(generation, eventSequence);
        return p;
      }
      if (p.mode !== "legacy" || p.revision !== expectedRevision)
        throw Error("History placement changed before preparation");
      this.reserveEventSequence(generation, eventSequence);
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
    recoveryToken?: string | null,
  ): HistoryGrant {
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
    const active = this.restores.active();
    if (active && (active.status === "fencing" || active.status === "switched"))
      throw Error("History restore is applying");
    const grant = this.address(
      this.restores.physical(generation),
      threadId,
      purpose === "stage" || purpose === "write",
      p.revision,
      p.mode === "remote" ? "remote" : "dual",
    );
    if (purpose === "write" && recoveryToken !== null)
      this.recovery.reserve(
        grant.generation,
        threadId,
        recoveryToken ?? crypto.randomUUID(),
      );
    return grant;
  }
  recoverySettled(
    generation: string,
    thread: string,
    token: string,
    state: RecoveryState,
  ) {
    this.ctx.storage.transactionSync(() =>
      this.recovery.settle(generation, thread, token, state),
    );
  }
  recoveryPage(
    generation: string,
    operation: RecoveryQuery,
    after: string | undefined,
    limit: number,
  ) {
    const p = this.status(),
      active = this.restores.active();
    if (
      p.mode !== "remote" ||
      p.generation !== generation ||
      (active && ["fencing", "switched"].includes(active.status))
    )
      throw Error("Active history changed during recovery");
    return this.recovery.page(
      this.restores.physical(generation),
      operation,
      after,
      limit,
    );
  }
  private address(
    generation: string,
    threadId: string,
    create: boolean,
    revision: number,
    mode: "remote" | "dual",
  ): HistoryGrant {
    requireThread(threadId);
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
      if (mode === "remote") this.recovery.initialize(generation, threadId);
      if (row.ordinal > 8387583) throw Error("History rowid ranges exhausted");
    }
    return {
      generation,
      threadId,
      ordinal: row?.ordinal ?? 0,
      revision,
      mode,
      base: this.restores.range(generation),
    };
  }
  list(generation: string, after?: string, limit = 32): ThreadPage {
    if (this.status().generation !== generation)
      throw Error("History generation changed");
    return this.threadPage(this.restores.physical(generation), after, limit);
  }
  private threadPage(
    generation: string,
    after: string | undefined,
    limit: number,
  ): ThreadPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256)
      throw Error("Invalid history page size");
    const rows = this.sql
      .exec<{
        thread: string;
      }>(
        "SELECT thread FROM shards WHERE generation=? AND thread>? ORDER BY thread LIMIT ?",
        generation,
        after ?? "",
        limit + 1,
      )
      .toArray();
    const threads = rows.slice(0, limit).map((row) => row.thread);
    return { threads, next: rows.length > limit ? threads.at(-1)! : null };
  }
  recordProof(
    generation: string,
    threadId: string,
    revision: number,
    proof: string | null,
    maximum?: string,
  ): void {
    const p = this.status();
    if (
      p.generation !== generation ||
      p.mode !== "dual" ||
      p.revision !== revision
    )
      throw Error("Import placement changed");
    if (maximum)
      this.restores.reserve(this.restores.physical(generation), maximum);
    this.sql.exec(
      "UPDATE shards SET proof=? WHERE generation=? AND thread=?",
      proof,
      generation,
      threadId,
    );
  }
  neverActivated(generation: string) {
    const p = this.status();
    return (
      p.mode === "legacy" &&
      p.generation === null &&
      this.sql
        .exec<{
          activated: number;
        }>("SELECT activated FROM generations WHERE name=?", generation)
        .toArray()[0]?.activated === 0
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
    if (this.restores.active())
      throw Error("An app restore must finish before operator cutover");
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
    recovery?: RecoveryState,
  ): void {
    const p = this.status();
    if (
      p.mode !== "held" ||
      p.generation !== generation ||
      p.revision !== revision
    )
      throw Error("History hold changed");
    if (recovery)
      this.recovery.fence(this.restores.physical(generation), thread, recovery);
    this.sql.exec(
      "UPDATE shards SET fenced=?,proof=? WHERE generation=? AND thread=?",
      revision,
      proof,
      this.restores.physical(generation),
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
      }>(
        "SELECT COUNT(*) threads,COUNT(*) FILTER (WHERE fenced<>?) pending FROM shards WHERE generation=?",
        revision,
        this.restores.physical(generation),
      )
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
        this.restores.physical(generation),
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

  restoreStatus(key: RestoreKey) {
    return this.restores.get(key);
  }
  restoreBegin(
    key: RestoreKey,
    expectedRevision: number,
    eventSequence?: string,
  ) {
    return this.ctx.storage.transactionSync(() => {
      const old = this.restores.get(key);
      if (!old) {
        const p = this.status();
        if (
          p.mode !== "remote" ||
          p.generation !== key.generation ||
          p.revision !== expectedRevision
        )
          throw Error("History changed before restore");
      }
      const job = this.restores.begin(key, expectedRevision);
      this.reserveEventSequence(
        job.physicalGeneration,
        eventSequence,
        job.status !== "preparing",
      );
      return job;
    });
  }
  restoreAddress(
    key: RestoreKey,
    thread: string,
    side: "stage" | "previous" | "target",
    revision?: number,
  ) {
    const job = this.restores.get(key),
      p = this.status();
    if (
      !job ||
      p.generation !== job.generation ||
      (revision !== undefined && p.revision !== revision)
    )
      throw Error("Restore lease changed");
    if (
      (side === "stage" && job.status !== "preparing") ||
      (side !== "stage" && job.status !== "fencing")
    )
      throw Error("Restore phase changed");
    return this.address(
      side === "previous" ? job.previous : job.physicalGeneration,
      thread,
      side === "stage",
      p.revision,
      "dual",
    );
  }
  restoreRecord(
    key: RestoreKey,
    thread: string,
    proof: string | null,
    maximum?: string,
  ) {
    const job = this.restores.get(key);
    if (job?.status !== "preparing") throw Error("Restore import is closed");
    if (maximum) this.restores.reserve(job.physicalGeneration, maximum);
    this.sql.exec(
      "UPDATE shards SET proof=? WHERE generation=? AND thread=?",
      proof,
      job.physicalGeneration,
      thread,
    );
  }
  restoreFreeze(key: RestoreKey, proofs: [string, string][]) {
    return this.ctx.storage.transactionSync(() => {
      const job = this.restores.get(key),
        p = this.status();
      if (!job || p.generation !== job.generation)
        throw Error("Unknown restore job");
      if (["switched", "finished", "fencing"].includes(job.status)) return job;
      if (
        job.status !== "preparing" ||
        p.revision !== job.previousRevision ||
        p.mode !== "remote"
      )
        throw Error("Restore source changed");
      const actual = this.sql
        .exec<{
          thread: string;
          proof: string | null;
        }>(
          "SELECT thread,proof FROM shards WHERE generation=?",
          job.physicalGeneration,
        )
        .toArray();
      const expected = new Map(proofs);
      if (
        expected.size !== proofs.length ||
        actual.length !== expected.size ||
        !actual.every(
          (row) => row.proof && row.proof === expected.get(row.thread),
        )
      )
        throw Error("Staged history does not match restore manifest");
      this.sql.exec(
        "UPDATE placement SET revision=revision+1 WHERE singleton=1",
      );
      return this.restores.phase(job, "fencing");
    });
  }
  restorePage(key: RestoreKey, side: "previous" | "target") {
    const job = this.restores.get(key);
    if (job?.status !== "fencing") throw Error("Restore fence changed");
    const revision = this.status().revision;
    const outstanding = this.sql
      .exec<{
        thread: string;
      }>(
        "SELECT thread FROM shards WHERE generation=? AND fenced<>? ORDER BY thread LIMIT 17",
        side === "previous" ? job.previous : job.physicalGeneration,
        revision,
      )
      .toArray();
    return {
      threads: outstanding.slice(0, 16).map((r) => r.thread),
      next: outstanding.length > 16 ? outstanding[15].thread : null,
    };
  }
  restoreFenced(
    key: RestoreKey,
    grant: HistoryGrant,
    proof: string | null,
    recovery?: RecoveryState,
  ) {
    const job = this.restores.get(key),
      p = this.status();
    if (
      job?.status !== "fencing" ||
      grant.revision !== p.revision ||
      ![job.previous, job.physicalGeneration].includes(grant.generation)
    )
      throw Error("Restore fence changed");
    if (grant.generation === job.physicalGeneration) {
      const staged = this.sql
        .exec<{
          proof: string | null;
        }>(
          "SELECT proof FROM shards WHERE generation=? AND thread=?",
          grant.generation,
          grant.threadId,
        )
        .one().proof;
      if (!proof || proof !== staged)
        throw Error("Restore shard changed after preparation");
    }
    if (recovery)
      this.recovery.fence(grant.generation, grant.threadId, recovery);
    this.sql.exec(
      "UPDATE shards SET fenced=? WHERE generation=? AND thread=?",
      grant.revision,
      grant.generation,
      grant.threadId,
    );
  }
  restoreSwitch(key: RestoreKey) {
    return this.ctx.storage.transactionSync(() => {
      const job = this.restores.get(key),
        p = this.status();
      if (!job) throw Error("Unknown restore job");
      if (job.status === "switched" || job.status === "finished") return job;
      if (
        job.status !== "fencing" ||
        this.sql
          .exec(
            "SELECT 1 FROM shards WHERE generation IN (?,?) AND fenced<>? LIMIT 1",
            job.previous,
            job.physicalGeneration,
            p.revision,
          )
          .toArray().length
      )
        throw Error("The history restore still has open writers");
      this.restores.select(job, job.physicalGeneration);
      return this.restores.phase(job, "switched");
    });
  }
  restoreClose(key: RestoreKey, mode: "finish" | "undo") {
    return this.ctx.storage.transactionSync(() => {
      const job = this.restores.get(key);
      if (!job) throw Error("Unknown restore job");
      const target = mode === "finish" ? "finished" : "undone";
      if (job.status === target) return job;
      if (
        ["finished", "undone"].includes(job.status) ||
        (mode === "finish" && job.status !== "switched")
      )
        throw Error("Restore is in a different phase");
      if (mode === "undo") this.restores.select(job, job.previous);
      this.sql.exec(
        "UPDATE placement SET revision=revision+1 WHERE singleton=1",
      );
      return this.restores.phase(job, target);
    });
  }
}
