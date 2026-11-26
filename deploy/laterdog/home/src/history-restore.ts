import { requireGeneration, type ShardAddress } from "./history-routing.ts";
type Phase = "preparing" | "fencing" | "switched" | "finished" | "undone";
export interface HistoryRestoreJob {
  jobId: string;
  generation: string;
  previous: string;
  physicalGeneration: string;
  previousRevision: number;
  status: Phase;
}
export interface RestoreKey {
  jobId: string;
  generation: string;
}
const columns =
  "job AS jobId,generation,previous,target AS physicalGeneration,revision AS previousRevision,phase AS status";
export class RestoreJournal {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS history_aliases(generation TEXT PRIMARY KEY,target TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS history_restores(job TEXT PRIMARY KEY,generation TEXT NOT NULL,previous TEXT NOT NULL,target TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,phase TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS history_bases(target TEXT PRIMARY KEY,base TEXT NOT NULL)",
    );
  }
  physical(generation: string) {
    return (
      this.sql
        .exec<{
          target: string;
        }>("SELECT target FROM history_aliases WHERE generation=?", generation)
        .toArray()[0]?.target ?? generation
    );
  }
  range(target: string) {
    return (
      this.sql
        .exec<{
          base: string;
        }>("SELECT base FROM history_bases WHERE target=?", target)
        .toArray()[0]?.base ?? String(2 ** 40)
    );
  }
  reserve(target: string, highest: string) {
    const value = BigInt(highest);
    if (value < BigInt(this.range(target))) return;
    const block = 2n ** 30n;
    const base = (value / block + 1n) * block;
    if (base + block >= 2n ** 63n)
      throw Error("Imported rowids have exhausted SQLite integer capacity");
    this.sql.exec(
      "INSERT INTO history_bases(target,base) VALUES(?,?) ON CONFLICT(target) DO UPDATE SET base=excluded.base",
      target,
      String(base),
    );
  }
  private read(
    row?: Record<string, string | number | null | ArrayBuffer>,
  ): HistoryRestoreJob | null {
    return row
      ? {
          jobId: String(row.jobId),
          generation: String(row.generation),
          previous: String(row.previous),
          physicalGeneration: String(row.physicalGeneration),
          previousRevision: Number(row.previousRevision),
          status: row.status as Phase,
        }
      : null;
  }
  active() {
    return this.read(
      this.sql
        .exec(
          "SELECT " +
            columns +
            " FROM history_restores WHERE phase IN ('preparing','fencing','switched') LIMIT 1",
        )
        .toArray()[0],
    );
  }
  get(key: RestoreKey) {
    requireGeneration(key.jobId);
    requireGeneration(key.generation);
    const job = this.read(
      this.sql
        .exec(
          "SELECT " + columns + " FROM history_restores WHERE job=?",
          key.jobId,
        )
        .toArray()[0],
    );
    if (job && job.generation !== key.generation)
      throw Error("Restore job belongs to another history generation");
    return job;
  }
  begin(key: RestoreKey, revision: number) {
    const old = this.get(key);
    if (old) {
      if (old.previousRevision !== revision)
        throw Error("Restore precondition changed");
      return old;
    }
    if (this.active()) throw Error("Another history restore is active");
    const target = "restore-" + crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO history_restores VALUES(?,?,?,?,?,'preparing')",
      key.jobId,
      key.generation,
      this.physical(key.generation),
      target,
      revision,
    );
    return this.get(key)!;
  }
  phase(job: HistoryRestoreJob, status: Phase) {
    this.sql.exec(
      "UPDATE history_restores SET phase=? WHERE job=?",
      status,
      job.jobId,
    );
    return this.get(job)!;
  }
  select(job: HistoryRestoreJob, target: string) {
    this.sql.exec(
      "INSERT INTO history_aliases(generation,target) VALUES(?,?) ON CONFLICT(generation) DO UPDATE SET target=excluded.target",
      job.generation,
      target,
    );
  }
}
export type HistoryGrant = ShardAddress & {
  revision: number;
  mode: "remote" | "dual";
  base: string;
};
