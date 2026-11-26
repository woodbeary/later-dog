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
