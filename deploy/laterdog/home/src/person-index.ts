import { DurableObject } from "cloudflare:workers";
import type {
  IndexFeedBatch,
  IndexMemoryRequest,
  IndexRecallRequest,
  IndexRecentRequest,
  IndexSearchRequest,
} from "../../../../shared/search-index-protocol.ts";
import { searchIndex, type SqlPort, type SqlValue } from "./person-index-store.ts";

export function durableSql(storage: DurableObjectStorage): SqlPort {
  return {
    all: <T>(query: string, ...params: SqlValue[]) => storage.sql.exec(query, ...params).toArray() as T[],
    script: (statements) => void storage.sql.exec(statements),
    batch: (work) => storage.transactionSync(work),
    size: () => storage.sql.databaseSize,
  };
}

export class PersonIndex extends DurableObject {
  private readonly index = searchIndex(durableSql(this.ctx.storage));
  feed(batch: IndexFeedBatch) {
    return this.index.feed(batch);
  }
  recall(request: IndexRecallRequest) {
    return this.index.recall(request);
  }
  recent(request: IndexRecentRequest) {
    return this.index.recent(request);
  }
  memory(request: IndexMemoryRequest) {
    return this.index.memory(request);
  }
  search(request: IndexSearchRequest) {
    return this.index.search(request);
  }
  stats() {
    return this.index.stats();
  }
}
