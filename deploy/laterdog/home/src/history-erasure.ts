import { createHash } from "node:crypto";
import { requireTenant } from "./history-routing.ts";

type Erasure = { token: string; phase: "deleting" | "deleted" | "reopened" };
type Physical = { generation: string; thread: string };
const generationHash = (value: string) => createHash("sha256").update(value).digest("hex");

export class HistoryErasure {
  private current?: Erasure;
  private readonly receipts = new Set<Promise<unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: DurableObjectStorage) {
    const sql = storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS home_erasure(singleton INTEGER PRIMARY KEY,token TEXT NOT NULL,phase TEXT NOT NULL)",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS retired_generations(fingerprint TEXT PRIMARY KEY)");
    sql.exec("CREATE TABLE IF NOT EXISTS completed_erasures(token TEXT PRIMARY KEY)");
    this.current = sql.exec<Erasure>("SELECT token,phase FROM home_erasure").toArray()[0];
  }
  serving() {
    return !this.current || this.current.phase === "reopened";
  }
  assertServing() {
    if (!this.serving()) throw Error("Conversation history has been removed");
  }
  allowGeneration(generation: string) {
    if (
      this.storage.sql
        .exec("SELECT 1 FROM retired_generations WHERE fingerprint=?", generationHash(generation))
        .toArray().length
    )
      throw Error("This history generation was retired");
  }
  admitReceipt<T>(run: () => Promise<T>) {
    this.assertServing();
    const job = run();
    this.receipts.add(job);
    return job.finally(() => this.receipts.delete(job));
  }
  private serial<T>(run: () => Promise<T>) {
    const job = this.queue.then(run);
    this.queue = job.catch(() => {});
    return job;
  }
  private phase(token: string, phase: Erasure["phase"]) {
    this.storage.sql.exec("INSERT OR REPLACE INTO home_erasure VALUES(1,?,?)", token, phase);
    this.current = { token, phase };
  }
  async batch(
    stable: string,
    token: string,
    receipts: R2Bucket,
    erase: (address: Physical) => Promise<void>,
  ) {
    requireTenant(stable);
    if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Invalid history removal");
    const sql = this.storage.sql;
    if (sql.exec("SELECT 1 FROM completed_erasures WHERE token=?", token).toArray().length)
      return true;
    if (this.current && !this.serving() && this.current.token !== token)
      throw Error("A different home removal is active");
    if (this.serving()) this.phase(token, "deleting");
    return this.serial(async () => {
      if (this.current?.token !== token) throw Error("History removal changed");
      if (this.current.phase !== "deleting") return true;
      await Promise.allSettled(this.receipts);
      const addresses = sql
        .exec<Physical>("SELECT generation,thread FROM shards ORDER BY ordinal LIMIT 16")
        .toArray();
      if (addresses.length) {
        const results = await Promise.allSettled(
          addresses.map(async (address) => {
            await erase(address);
            sql.exec(
              "DELETE FROM shards WHERE generation=? AND thread=?",
              address.generation,
              address.thread,
            );
          }),
        );
        for (const result of results) if (result.status === "rejected") throw result.reason;
        return false;
      }
      const prefix = "homes/" + stable + "/history/";
      const page = await receipts.list({ prefix, limit: 256 });
      if (page.objects.length) {
        await receipts.delete(page.objects.map((o) => o.key));
        return false;
      }
      const generations = sql
        .exec<{
          name: string;
        }>(
          "SELECT name FROM generations UNION ALL SELECT target AS name FROM history_restores UNION ALL SELECT target AS name FROM history_aliases UNION ALL SELECT target AS name FROM history_bases LIMIT 64",
        )
        .toArray();
      if (generations.length) {
        this.storage.transactionSync(() => {
          for (const { name } of generations) {
            sql.exec("INSERT OR IGNORE INTO retired_generations VALUES(?)", generationHash(name));
            sql.exec("DELETE FROM generations WHERE name=?", name);
            for (const table of ["history_restores", "history_aliases", "history_bases"])
              sql.exec("DELETE FROM " + table + " WHERE target=?", name);
          }
        });
        return false;
      }
      this.storage.transactionSync(() => {
        const privateTables = sql
          .exec<{
            name: string;
          }>("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'history_*'")
          .toArray();
        for (const { name } of privateTables) {
          if (!/^history_[a-z0-9_]+$/.test(name)) throw Error("Unexpected private history table");
          sql.exec('DELETE FROM "' + name + '"');
        }
        sql.exec(
          "UPDATE placement SET mode='legacy',generation=NULL,revision=revision+1 WHERE singleton=1",
        );
        sql.exec("INSERT OR IGNORE INTO completed_erasures VALUES(?)", token);
        sql.exec("UPDATE home_erasure SET phase='deleted' WHERE singleton=1 AND token=?", token);
      });
      this.current = { token, phase: "deleted" };
      return true;
    });
  }
  reopen(token: string) {
    if (this.current?.token !== token || this.current.phase === "deleting")
      throw Error("History removal must finish before reopening");
    this.phase(token, "reopened");
  }
}
