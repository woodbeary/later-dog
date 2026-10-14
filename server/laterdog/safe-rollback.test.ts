import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { rollbackQuietly } from "./safe-rollback.ts";

describe("rolling back after a failed write", () => {
  it("rolls back an open transaction", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE t (n INTEGER)");
    database.exec("BEGIN");
    database.exec("INSERT INTO t VALUES (1)");
    rollbackQuietly(database);
    expect(database.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
  });

  it("does not hide the original failure when SQLite already ended the transaction", () => {
    const database = new DatabaseSync(":memory:");
    const original = new Error("database or disk is full");
    const attempt = () => {
      try {
        throw original;
      } catch (error) {
        rollbackQuietly(database);
        throw error;
      }
    };
    expect(attempt).toThrow(original);
    expect(() => database.exec("ROLLBACK")).toThrow(/no transaction is active/);
  });
});
