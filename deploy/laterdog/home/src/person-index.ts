import { DurableObject } from "cloudflare:workers";
import type {
  IndexFeedBatch,
  IndexFilesRequest,
  IndexHasRequest,
  IndexMemoryRequest,
  IndexRecallRequest,
  IndexRecentRequest,
  IndexSearchRequest,
} from "../../../../shared/search-index-protocol.ts";
import { searchIndex, type SearchIndex, type SqlPort, type SqlValue } from "./person-index-store.ts";

export function durableSql(storage: DurableObjectStorage): SqlPort {
  return {
    all: <T>(query: string, ...params: SqlValue[]) => storage.sql.exec(query, ...params).toArray() as T[],
    script: (statements) => void storage.sql.exec(statements),
    batch: (work) => storage.transactionSync(work),
    size: () => storage.sql.databaseSize,
  };
}

abstract class IndexObject extends DurableObject {
  protected abstract readonly index: SearchIndex;
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
  has(request: IndexHasRequest) {
    return this.index.has(request);
  }
  files(request: IndexFilesRequest) {
    return this.index.files(request);
  }
  stats() {
    return this.index.stats();
  }
}

export class PersonIndex extends IndexObject {
  protected readonly index = searchIndex(durableSql(this.ctx.storage));
}

export class DogIndex extends IndexObject {
  protected readonly index = searchIndex(durableSql(this.ctx.storage), { substring: false, broadMatches: Number.POSITIVE_INFINITY });
}
