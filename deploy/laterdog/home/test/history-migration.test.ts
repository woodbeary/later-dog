import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureNativeRuns } from "../../../../server/laterdog/native-run-store.ts";
import {
  capture,
  readCatalog,
  verifiedRows,
} from "../migration/history/package.mjs";
import { compact } from "../migration/history/projection.mjs";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "history-shards-"));
  cleanup.push(dir);
  const source = join(dir, "messages.db");
  const db = new DatabaseSync(source);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE messages (thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));
    CREATE INDEX messages_thread ON messages(thread_id);
    CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);
    CREATE TABLE command_receipts(kind TEXT,key TEXT,at INTEGER,result TEXT,PRIMARY KEY(kind,key));
    CREATE VIRTUAL TABLE messages_fts USING fts5(text,content='messages',content_rowid='rowid');
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,text) VALUES(new.rowid,new.text); END;`);
  ensureNativeRuns(db);
  db.exec(`INSERT INTO native_runs(id,thread_id,started_at,json) VALUES('run','one',55,'{}');
    INSERT INTO native_run_events(sequence,run_id,event_id,at,json) VALUES(22,'run','event',55,'{ "kept":true }'),(31,'run','other',55,'null');
    DELETE FROM native_run_events WHERE sequence=31;
    INSERT INTO native_run_items(rowid,run_id,id,sequence,json) VALUES(10,'run','activity',7,'{}');
    INSERT INTO native_run_retention(thread_id) VALUES('one');
    INSERT INTO command_receipts VALUES('send','once',55,'{"ok":true}');
    INSERT INTO thread_state VALUES('one','fork');`);
  const message = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)");
  for (const [thread, id, parent] of [
    ["one", "root", null],
    ["one", "reply", "root"],
    ["one", "fork", "root"],
    ["two", "root", null],
  ])
    message.run(
      thread,
      id,
      55,
      "user",
      "text",
      "alpha",
      JSON.stringify({ id, parent, attachments: [{ path: "art/a" }] }),
    );
  return { dir, db, source };
}

it("captures the committed live WAL and exact rows, fork, native payload and allocator high water", async () => {
  const { db, dir, source } = fixture();
  try {
    db.prepare("UPDATE messages SET json=? WHERE thread_id='two'").run(
      "\uFEFFraw\u0000bytes",
    );
    writeFileSync(
      join(dir, "messages-old.json"),
      JSON.stringify({
        messages: [
          { id: "old", at: 1, role: "user", kind: "text", text: "legacy" },
        ],
        activeLeafId: "old",
      }),
    );
    const pkg = join(dir, "pack"),
      receipt = await capture(source, pkg),
      catalog = readCatalog(pkg, receipt.sha256);
    expect(catalog.legacy).toHaveLength(1);
    expect(catalog.eventSequence).toBe("31");
    expect(
      catalog.shards.map(
        (s: { proof: { threadId: string } }) => s.proof.threadId,
      ),
    ).toEqual(["old", "one", "two"]);
    const one = catalog.shards[1],
      two = catalog.shards[2];
    expect(
      [...verifiedRows(pkg, "one", "native_run_events", one)][0].at(-1),
    ).toBe('{ "kept":true }');
    expect([...verifiedRows(pkg, "two", "messages", two)][0].at(-1)).toBe(
      "\uFEFFraw\u0000bytes",
    );
    const target = join(dir, "history-control.db");
    await compact(source, pkg, receipt.sha256, target, "g1");
    const compacted = new DatabaseSync(target, { readOnly: true });
    try {
      expect(
        compacted.prepare("SELECT count(*) AS n FROM messages").get()?.n,
      ).toBe(0);
      expect(
        compacted
          .prepare("SELECT generation FROM history_control_generation")
          .get()?.generation,
      ).toBe("g1");
      expect(
        compacted.prepare("SELECT result FROM command_receipts").get()?.result,
      ).toBe(
        "history:v1:" +
          createHash("sha256").update('{"ok":true}').digest("hex"),
      );
      expect(
        compacted.prepare("SELECT seq FROM sqlite_sequence").get()?.seq,
      ).toBe(31);
    } finally {
      compacted.close();
    }
    db.exec("INSERT INTO command_receipts VALUES('send','second',55,'{}')");
    await expect(
      compact(source, pkg, receipt.sha256, join(dir, "stale.db"), "g1"),
    ).rejects.toThrow("changed");
  } finally {
    db.close();
  }
});

it("refuses orphan native history and rowid allocations crossing the reserved shard range", async () => {
  const { db, dir, source } = fixture();
  try {
    db.exec("INSERT INTO native_run_items VALUES('missing','item',0,'{}')");
    await expect(capture(source, join(dir, "bad"))).rejects.toThrow(
      "no native run",
    );
    db.exec(
      "DELETE FROM native_run_items WHERE run_id='missing'; UPDATE messages SET rowid=1099511627776 WHERE thread_id='two'",
    );
    await expect(capture(source, join(dir, "bad"))).rejects.toThrow("reserved");
  } finally {
    db.close();
  }
});
