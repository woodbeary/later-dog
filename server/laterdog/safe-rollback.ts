import type { DatabaseSync } from "node:sqlite";

export function rollbackQuietly(database: DatabaseSync, statement = "ROLLBACK"): void {
  try {
    database.exec(statement);
  } catch {}
}
