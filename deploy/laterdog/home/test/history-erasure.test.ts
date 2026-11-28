import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { HistoryErasure } from "../src/history-erasure.ts";
import { putReceipt } from "../src/history-receipts.ts";

const tenant = "a".repeat(64),
  token = "b".repeat(64);
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function journal() {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec: (sql: string, ...params: (number | string)[]) => {
        const rows = db.prepare(sql).all(...params);
        return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
      },
    },
    transactionSync: <T>(run: () => T) => {
      db.exec("BEGIN");
      try {
        const result = run();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  db.exec(
    "CREATE TABLE shards(ordinal INTEGER PRIMARY KEY,generation TEXT,thread TEXT); CREATE TABLE generations(name TEXT); CREATE TABLE history_restores(target TEXT); CREATE TABLE history_aliases(target TEXT); CREATE TABLE history_bases(target TEXT,base TEXT);CREATE TABLE history_recovery(thread TEXT);CREATE TABLE history_recovery_intents(thread TEXT); CREATE TABLE placement(singleton INTEGER PRIMARY KEY,mode TEXT,generation TEXT,revision INTEGER); INSERT INTO placement VALUES(1,'remote','live',12)",
  );
  return { db, restart: () => new HistoryErasure(storage as unknown as DurableObjectStorage) };
}

describe("erasing all tenant-owned conversation data", () => {
  it("keeps active, abandoned and restore targets fenced through an interrupted removal", async () => {
    const { db, restart } = journal();
    try {
      db.exec(
        "INSERT INTO generations VALUES('abandoned'),('live');INSERT INTO history_restores VALUES('restore-private');INSERT INTO history_aliases VALUES('restore-private');INSERT INTO history_bases VALUES('live','1234');INSERT INTO history_recovery VALUES('private thread');INSERT INTO history_recovery_intents VALUES('pending private thread');INSERT INTO shards VALUES(1,'abandoned','old'),(2,'live','active'),(3,'restore-private','staged')",
      );
      const originals = new Set(["abandoned/old", "live/active", "restore-private/staged"]);
      const objects = new Set([
        "homes/" + tenant + "/history/receipts/v1/old/history",
        "homes/" + tenant + "/history/receipts/v1/live/receipt",
        "homes/other/history/receipts/v1/live/receipt",
      ]);
      let refused = true;
      const erase = async (a: { generation: string; thread: string }) => {
        if (a.thread === "active" && refused) throw Error("Shard unavailable");
        originals.delete(a.generation + "/" + a.thread);
      };
      const bucket = {
        list: async ({ prefix }: { prefix: string }) => ({
          objects: [...objects].filter((x) => x.startsWith(prefix)).map((key) => ({ key })),
        }),
        delete: async (keys: string[]) => keys.forEach((k) => objects.delete(k)),
      } as unknown as R2Bucket;
      let erasure = restart();
      const release = Promise.withResolvers<void>();
      const writing = erasure.admitReceipt(() => release.promise);
      const removing = erasure.batch(tenant, token, bucket, erase);
      expect(() => erasure.admitReceipt(async () => {})).toThrow("removed");
      expect(originals.size).toBe(3);
      release.resolve();
      await writing;
      await expect(removing).rejects.toThrow("unavailable");
      expect([...originals]).toEqual(["live/active"]);
      erasure = restart();
      expect(erasure.serving()).toBe(false);
      await expect(erasure.batch(tenant, "c".repeat(64), bucket, erase)).rejects.toThrow(
        "different",
      );
      expect(() => erasure.reopen(token)).toThrow("finish");
      refused = false;
      while (!(await erasure.batch(tenant, token, bucket, erase))) continue;
      expect(originals.size).toBe(0);
      expect([...objects]).toEqual(["homes/other/history/receipts/v1/live/receipt"]);
      for (const table of [
        "shards",
        "history_restores",
        "history_aliases",
        "history_bases",
        "history_recovery",
        "history_recovery_intents",
        "generations",
      ])
        expect(db.prepare("SELECT * FROM " + table).all()).toEqual([]);
      erasure = restart();
      expect(erasure.serving()).toBe(false);
      erasure.reopen(token);
      erasure = restart();
      expect(erasure.serving()).toBe(true);
      for (const name of ["live", "abandoned", "restore-private"])
        expect(() => erasure.allowGeneration(name)).toThrow("retired");
      erasure.allowGeneration("fresh");
      expect(db.prepare("SELECT mode,generation,revision FROM placement").get()).toMatchObject({
        mode: "legacy",
        generation: null,
        revision: 13,
      });
      db.exec("INSERT INTO shards VALUES(4,'fresh','new')");
      expect(await erasure.batch(tenant, token, bucket, erase)).toBe(true);
      expect(db.prepare("SELECT thread FROM shards").get()?.thread).toBe("new");
    } finally {
      db.close();
    }
  });

  it("refuses a delayed receipt payload after its original reservation has been erased", async () => {
    const value = new TextEncoder().encode("private receipt");
    const hash = sha(value);
    const admitted = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let object: {
      etag: string;
      size: number;
      customMetadata: Record<string, string>;
      checksums: { sha256?: ArrayBuffer };
      bytes: Uint8Array;
    } | null = null;
    const bucket = {
      async put(
        _key: string,
        bytes: Uint8Array,
        opts: {
          onlyIf: { etagDoesNotMatch?: string; etagMatches?: string };
          customMetadata?: Record<string, string>;
          sha256?: string;
        },
      ) {
        if (opts.onlyIf.etagMatches) {
          admitted.resolve();
          await release.promise;
          if (object?.etag !== opts.onlyIf.etagMatches) return null;
        }
        if (opts.onlyIf.etagDoesNotMatch && object) return null;
        object = {
          etag: sha(bytes),
          size: bytes.length,
          customMetadata: opts.customMetadata ?? {},
          checksums: {},
          bytes,
        };
        return object;
      },
      head: async () => object,
    } as unknown as R2Bucket;
    const task = putReceipt(bucket, tenant, "one", hash, value);
    await admitted.promise;
    object = null;
    release.resolve();
    await expect(task).rejects.toThrow("fenced");
    expect(object).toBeNull();
  });
});
