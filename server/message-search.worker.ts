import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { searchMessagesInDatabase } from "./message-search-query.ts";
import { BUDGET_FUNCTION, type ReadQuery } from "./message-search-worker.ts";

type Request = { id: number } & ({ query: string; limit: number; threadId?: string } | { reads: ReadQuery[] });

parentPort!.on("message", (request: Request) => {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(workerData.file, { readOnly: true });
    if ("reads" in request) {
      const database = db;
      const deadline = performance.now() + workerData.budgetMs;
      database.function(BUDGET_FUNCTION, { deterministic: false }, () => {
        if (performance.now() > deadline) throw new Error("over budget");
        return 1;
      });
      parentPort!.postMessage({ id: request.id, rows: request.reads.map((read) => database.prepare(read.sql).all(...read.params)) });
    } else {
      parentPort!.postMessage({ id: request.id, hits: searchMessagesInDatabase(db, request.query, request.limit, request.threadId) });
    }
  } catch {
    parentPort!.postMessage({ id: request.id, failed: true });
  } finally {
    db?.close();
  }
});
