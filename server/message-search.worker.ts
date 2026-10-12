import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { searchMessagesInDatabase } from "./message-search-query.ts";

parentPort!.on("message", (request: { id: number; query: string; limit: number; threadId?: string }) => {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(workerData.file, { readOnly: true });
    const hits = searchMessagesInDatabase(db, request.query, request.limit, request.threadId);
    parentPort!.postMessage({ id: request.id, hits });
  } catch {
    parentPort!.postMessage({ id: request.id, failed: true });
  } finally {
    db?.close();
  }
});
