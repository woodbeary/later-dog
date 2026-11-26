import { createHash } from "node:crypto";
import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureNativeRuns } from "../../../../server/laterdog/native-run-store.ts";
import { HISTORY_TABLES } from "../../../../shared/history-migration.ts";
import { capture, readCatalog } from "../migration/history/package.mjs";
import { compact, reconstruct } from "../migration/history/projection.mjs";
import { fileHash } from "../migration/history/sqlite.mjs";
import {
  exportFrozen,
  publishCatalog,
} from "../migration/history/transfer.mjs";

function binding() {
  const shards = new Map(),
    counters = { resets: 0, pages: 0, large: 0 };
  const control = {
    mode: "dual",
    generation: "test",
    revision: 1,
    failOnAppend: true,
    reservedEventSequence: null as string | null,
    barrier: true,
  };
  function target(id) {
    return shards.get(id);
  }
  function append(req) {
    const s = target(req.threadId);
    expect(req.loadId).toBe(s.loadId);
    for (const row of req.rows) {
      const table = s.rows[req.table];
      const prior = table.get(row[0]);
      if (prior) expect(prior).toEqual(row);
      else table.set(row[0], row);
    }
    if (control.failOnAppend) {
      control.failOnAppend = false;
      throw Error("lost response");
    }
    return { count: req.rows.length };
  }
  const receipts = new Map();
  const api = {
    async receiptBatch({ op, items }) {
      return {
        items: items.map((item) => {
          if (op === "put") {
            receipts.set(item.sha256, item.value);
            return {
              sha256: item.sha256,
              bytes: Buffer.byteLength(item.value),
            };
          }
          return { sha256: item.sha256, value: receipts.get(item.sha256) };
        }),
      };
    },
    async admin(q) {
      const s = target(q.threadId);
      switch (q.op) {
        case "begin":
          control.reservedEventSequence = q.eventSequence ?? null;
          return control;
        case "status":
          return control;
        case "list":
          return { threads: [...shards.keys()].sort(), next: null };
        case "barrier":
          return { held: control.barrier, threads: shards.size };
        case "commands":
          return {
            rows:
              q.threadId === "one"
                ? [
                    {
                      sequence: "1",
                      rowid: "8",
                      kind: "remote",
                      key: "accepted",
                      at: "80",
                      resultRef:
                        "history:v1:" +
                        createHash("sha256").update("new").digest("hex"),
                    },
                  ]
                : [],
            next: null,
          };
        case "watermark":
          return { nativeEventSequence: "1099511627779" };
        case "shardStatus":
          return { loadId: s?.loadId ?? null, sha256: s?.sha256 ?? null };
        case "reset":
          if (s?.loadId === q.loadId) return { loadId: q.loadId };
          expect(s?.loadId ?? null).toBe(q.expectedLoadId);
          counters.resets++;
          shards.set(q.threadId, {
            loadId: q.loadId,
            sha256: null,
            rows: Object.fromEntries(HISTORY_TABLES.map((t) => [t, new Map()])),
          });
          return { loadId: q.loadId };
        case "import":
          return append(q);
        case "seal":
          s.sha256 = q.proof.sha256;
          return { sha256: s.sha256 };
        default:
          throw Error("Unknown op");
      }
    },
    async page(q) {
      counters.pages++;
      const rows = [...target(q.threadId).rows[q.table].values()]
        .filter((r) => q.after === undefined || BigInt(r[0]) > BigInt(q.after))
        .sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
      return {
        rows: rows.slice(0, 1),
        next: rows.length > 1 ? rows[0][0] : null,
      };
    },
    async importStream(req, stream) {
      counters.large++;
      return append({ ...req, rows: [await new Response(stream).json()] });
    },
  };
  return { api, shards, counters, control, receipts };
}

it("reconciles a lost response, a vanished shard, a changed shard and late controls, then rebuilds each current raw row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-rollback-"));
  const source = join(dir, "messages.db"),
    data = join(dir, "rows"),
    journal = join(dir, "journal"),
    coord = join(dir, "history-control.db");
  const db = new DatabaseSync(source);
  try {
    db.exec(
      `CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id));CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);CREATE TABLE command_receipts(kind TEXT,key TEXT,at INTEGER,result TEXT,PRIMARY KEY(kind,key));INSERT INTO command_receipts VALUES('operation','before',1,'ok')`,
    );
    ensureNativeRuns(db);
    const ins = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)");
    ins.run("one", "base", 1, "user", "text", null, "x".repeat(3 * 1024 ** 2));
    ins.run("two", "base", 1, "user", "text", "other", "{}");
    ins.run("three", "base", 1, "user", "text", "third", "{}");
    const env = binding(),
      opts = {
        stable: "a".repeat(64),
        generation: "test",
        expectedRevision: 0,
        concurrency: 1,
      };
    const hot = await capture(source, data);
    await expect(
      publishCatalog(env.api, data, hot.sha256, journal, opts),
    ).rejects.toThrow("lost response");
    await publishCatalog(env.api, data, hot.sha256, journal, opts);
    expect(env.counters.resets).toBe(3);
    expect(env.counters.large).toBeGreaterThan(0);
    const pages = env.counters.pages;
    await publishCatalog(env.api, data, hot.sha256, journal, opts);
    expect(env.counters.pages).toBe(pages);
    db.exec(
      "UPDATE messages SET text='edit' WHERE thread_id='two';DELETE FROM messages WHERE thread_id='three'",
    );
    const frozen = await capture(source, data);
    await publishCatalog(env.api, data, frozen.sha256, journal, opts);
    expect(env.counters.resets).toBe(5);
    expect(env.shards.get("three").rows.messages.size).toBe(0);
    await compact(source, data, frozen.sha256, coord, "test");
    const live = new DatabaseSync(coord);
    const sha = createHash("sha256").update("new").digest("hex");
    env.receipts.set(sha, "new");
    live
      .prepare("INSERT INTO command_receipts VALUES('operation','after',2,?)")
      .run("history:v1:" + sha);
    live.close();
    const high = "1099511627781",
      one = env.shards.get("one").rows;
    one.messages.set(high, [
      high,
      "one",
      "late",
      "888",
      "assistant",
      "text",
      "latest",
      '{ "metadata": {"branch": "base"} }',
    ]);
    one.thread_state.set(high, [high, "one", "late"]);
    env.shards.get("two").rows.messages.clear();
    env.control.mode = "held";
    env.control.revision = 3;
    const held = { ...opts, revision: 3, sourceSha256: await fileHash(coord) };
    env.control.barrier = false;
    await expect(exportFrozen(env.api, data, held)).rejects.toThrow(
      "barrier incomplete",
    );
    env.control.barrier = true;
    const remote = await exportFrozen(env.api, data, held);
    expect(readCatalog(data, remote.sha256).shards).toHaveLength(3);
    const out = join(dir, "restored.db");
    await reconstruct(coord, data, remote.sha256, out, "test", env.api);
    const restore = new DatabaseSync(out, { readOnly: true });
    try {
      expect(
        restore
          .prepare("SELECT text,json FROM messages WHERE rowid=?")
          .get(BigInt(high)),
      ).toMatchObject({
        text: "latest",
        json: '{ "metadata": {"branch": "base"} }',
      });
      expect(
        restore
          .prepare(
            "SELECT active_leaf_id FROM thread_state WHERE thread_id='one'",
          )
          .get()?.active_leaf_id,
      ).toBe("late");
      expect(
        restore
          .prepare("SELECT count(*) n FROM messages WHERE thread_id!='one'")
          .get()?.n,
      ).toBe(0);
      expect(
        restore.prepare("SELECT count(*) n FROM command_receipts").get()?.n,
      ).toBe(3);
      expect(
        restore
          .prepare(
            "SELECT CAST(seq AS TEXT) s FROM sqlite_sequence WHERE name='native_run_events'",
          )
          .get()?.s,
      ).toBe("1099511627779");
    } finally {
      restore.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reserves the original event cursor even when a previously sharded database has deleted every event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-event-watermark-"));
  const source = join(dir, "messages.db"),
    pack = join(dir, "pack");
  const db = new DatabaseSync(source);
  try {
    db.exec(
      "CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT)",
    );
    ensureNativeRuns(db);
    db.exec(
      "INSERT INTO sqlite_sequence(name,seq) VALUES('native_run_events',9007199254740995)",
    );
    const snap = await capture(source, pack, { portable: true });
    const env = binding();
    await publishCatalog(env.api, pack, snap.sha256, join(dir, "journal"), {
      stable: "a".repeat(64),
      generation: "test",
      expectedRevision: 0,
    });
    expect(env.control.reservedEventSequence).toBe("9007199254740995");
    expect(env.shards.size).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
