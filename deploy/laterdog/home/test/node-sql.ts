import { DatabaseSync } from "node:sqlite";
import type { SqlPort, SqlValue } from "../src/person-index-store.ts";

export function nodeSql(database = new DatabaseSync(":memory:")): SqlPort {
  return {
    all: <T>(query: string, ...params: SqlValue[]) => database.prepare(query).all(...params) as T[],
    script: (statements) => database.exec(statements),
    batch: (work) => {
      database.exec("BEGIN");
      try {
        work();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    size: () => {
      const pages = database.prepare("PRAGMA page_count").get() as { page_count: number };
      const size = database.prepare("PRAGMA page_size").get() as { page_size: number };
      return pages.page_count * size.page_size;
    },
  };
}
