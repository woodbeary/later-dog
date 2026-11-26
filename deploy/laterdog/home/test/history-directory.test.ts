import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { HistoryDirectory } from "../src/history-directory.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState) {}
  },
}));

function database() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...params: (string | number | null)[]) {
      const rows = db.prepare(query).all(...params);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw Error("Query did not return one row");
          return rows[0];
        },
      };
    },
  };
  const storage = {
    sql,
    transactionSync<T>(operation: () => T): T {
      db.exec("BEGIN");
      try {
        const result = operation();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const open = () =>
    new HistoryDirectory({ storage } as unknown as DurableObjectState, {});
  return { db, open };
}

describe("per-home history activation", () => {
  const checksum = "a".repeat(64);
  it("keeps live history fenced until every registered shard and checksum agree", () => {
    const { db, open } = database();
    try {
      const dir = open();
      dir.begin("first", 0);
      dir.open("first", "a", "stage");
      dir.recordProof("first", "a", 1, checksum);
      dir.hold("first", 1);
      expect(open().barrier("first", 2)).toEqual({ held: false, threads: 1 });
      expect(() => dir.open("first", "new", "write")).toThrow();
      expect(() =>
        dir.finish("first", 2, "remote", [["a", checksum]]),
      ).toThrow();
      dir.fenced("first", "a", 2, checksum);
      expect(() =>
        dir.finish("first", 2, "remote", [["a", "b".repeat(64)]]),
      ).toThrow();
      expect(dir.finish("first", 2, "remote", [["a", checksum]]).mode).toBe(
        "remote",
      );
      expect(() => dir.abandon("first", 3)).toThrow();
      expect(dir.neverActivated("first")).toBe(false);
    } finally {
      db.close();
    }
  });
  it("tracks unsettled history writes and isolates cold recovery by physical generation", () => {
    const { db, open } = database();
    try {
      const dir = open();
      dir.begin("first", 0);
      for (const thread of ["a", "b", "old"])
        dir.open("first", thread, "stage");
      dir.hold("first", 1);
      for (const thread of ["a", "b"])
        dir.fenced("first", thread, 2, checksum, {
          version: 1,
          recoverable: 0,
          head: null,
        });
      dir.fenced("first", "old", 2, checksum);
      dir.finish(
        "first",
        2,
        "remote",
        ["a", "b", "old"].map((thread) => [thread, checksum]),
      );
      const active = () =>
        open()
          .recoveryPage("first", "native.recover", undefined, 32)
          .rows.map((r) => r.thread);
      expect(active()).toEqual(["old"]);
      dir.open("first", "b", "write", "one");
      dir.open("first", "b", "write", "two");
      expect(active()).toEqual(["b", "old"]);
      open().recoverySettled("first", "b", "two", {
        version: 3,
        recoverable: 0,
        head: "20",
      });
      expect(active()).toEqual(["b", "old"]);
      open().recoverySettled("first", "b", "one", {
        version: 2,
        recoverable: 1,
        head: "10",
      });
      expect(active()).toEqual(["old"]);
      expect(
        open().recoveryPage("first", "messages.commandHead", undefined, 1),
      ).toEqual({
        rows: [{ thread: "b", uncertain: 0, head: "20",cards:null,facts:null }],
        next: "b",
      });
      dir.open("first", "a", "write");
      expect(active()).toEqual(["a", "old"]);
      dir.open("first", "new", "write", null);
      expect(active()).toEqual(["a", "old"]);
      dir.hold("first", 3);
      expect(() =>
        open().recoveryPage("first", "messages.commandHead", undefined, 32),
      ).toThrow();
      dir.fenced("first", "a", 4, checksum, {
        version: 10,
        recoverable: 0,
        head: null,
      });
      open().recoverySettled("first", "a", "stale", {
        version: 11,
        recoverable: 1,
        head: "999",
      });
      const rows = db
        .prepare(
          "SELECT recoverable,head FROM history_recovery WHERE thread='a'",
        )
        .all();
      expect(rows).toEqual([{ recoverable: 0, head: null }]);
    } finally {
      db.close();
    }
  });
  it("reserves deleted event rowids on initial import and portable restore", () => {
    const { db,open } = database();
    try {
      const dir = open();
      expect(()=>dir.begin("first",0,"9223372036854775807")).toThrow();
      expect(dir.status().mode).toBe("legacy");
      dir.begin("first",0,"9007199254740995");
      expect(BigInt(dir.open("first","t","stage").base)).toBeGreaterThan(9007199254740995n);
      dir.hold("first",1);
      dir.fenced("first","t",2,checksum);
      dir.finish("first",2,"remote",[["t",checksum]]);
      const key={generation:"first",jobId:"replace"};
      dir.restoreBegin(key,3,"18014398509481990");
      expect(BigInt(dir.restoreAddress(key,"t","stage").base)).toBeGreaterThan(18014398509481990n);
    } finally {db.close();}
  });
  it("remembers a cancelled enrollment across a cold open", () => {
    const { db, open } = database();
    try {
      open().begin("unused", 0);
      open().hold("unused", 1);
      open().abandon("unused", 2);
      expect(open().neverActivated("unused")).toBe(true);
      expect(open().neverActivated("unknown")).toBe(false);
    } finally {
      db.close();
    }
  });
  it("restores the previous generation on a failed portable restore and rejects old writers", () => {
    const { db, open } = database();
    try {
      const dir = open(),
        generation = "initial",
        key = { jobId: "portable", generation };
      dir.begin(generation, 0);
      dir.hold(generation, 1);
      dir.finish(generation, 2, "remote", []);
      const original = dir.open(generation, "old", "write");
      dir.restoreBegin(key, 3);
      dir.restoreAddress(key, "new", "stage");
      dir.restoreRecord(key, "new", checksum, "9007199254743002");
      dir.restoreFreeze(key, [["new", checksum]]);
      expect(() => dir.open(generation, "old", "write")).toThrow();
      expect(() => dir.restoreSwitch(key)).toThrow();
      for (const [side, id] of [
        ["previous", "old"],
        ["target", "new"],
      ] as const) {
        const grant = dir.restoreAddress(key, id, side, 4);
        dir.restoreFenced(key, grant, checksum);
      }
      expect(dir.restoreSwitch(key).status).toBe("switched");
      expect(() => open().open(generation, "new", "read")).toThrow();
      expect(open().restoreClose(key, "undo").status).toBe("undone");
      expect(open().open(generation, "old", "read").generation).toBe(
        original.generation,
      );
      expect(open().list(generation).threads).toEqual(["old"]);
    } finally {
      db.close();
    }
  });
});
