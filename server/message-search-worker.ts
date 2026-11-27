import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { SQLInputValue } from "node:sqlite";
import type { SearchHit } from "./message-search-query.ts";

export class SearchUnavailable extends Error {
  readonly status = 503;
}

export const SEARCH_TOO_SLOW = "Searching took too long. Try a narrower search: one dog instead of all, a shorter span, or more specific words.";

export const BUDGET_FUNCTION = "laterdog_within_budget";
export const WITHIN_BUDGET = ` AND ${BUDGET_FUNCTION}()`;

export interface ReadQuery {
  sql: string;
  params: SQLInputValue[];
}

type Request = { query: string; limit: number; threadId?: string } | { reads: ReadQuery[] };

export class MessageSearchWorker {
  private worker: Worker | undefined;
  private stopping: Promise<void> = Promise.resolve();
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve: (rows: never) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private readonly file: string;
  private readonly timeoutMs: number;
  constructor(file: string, timeoutMs = 30_000) {
    this.file = file;
    this.timeoutMs = timeoutMs;
  }

  search(query: string, limit: number, threadId?: string): Promise<SearchHit[]> {
    return this.ask<SearchHit[]>({ query, limit, threadId });
  }

  read(reads: ReadQuery[]): Promise<unknown[][]> {
    return this.ask<unknown[][]>({ reads });
  }

  private ask<T>(request: Request): Promise<T> {
    if (this.pending.size >= 8) return Promise.reject(new SearchUnavailable("Search is busy. Try again shortly."));
    if (!this.worker) {
      const source = new URL("./message-search.worker.ts", import.meta.url);
      const worker = new Worker(existsSync(source) ? source : new URL("./message-search.worker.js", import.meta.url), {
        workerData: { file: this.file, budgetMs: this.timeoutMs },
        execArgv: [],
      });
      this.worker = worker;
      worker.on("message", (reply: { id: number; hits?: SearchHit[]; rows?: unknown[][]; failed?: boolean }) => {
        if (this.worker !== worker) return;
        const request = this.pending.get(reply.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(reply.id);
        if (reply.failed) request.reject(new SearchUnavailable("Search could not finish. Try again shortly."));
        else request.resolve((reply.rows ?? reply.hits ?? []) as never);
        if (!this.pending.size) worker.unref();
      });
      worker.on("error", () => {
        if (this.worker === worker) void this.close();
      });
      worker.on("exit", () => {
        if (this.worker === worker) void this.close();
      });
    }
    const worker = this.worker;
    worker.ref();
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { void this.close(SEARCH_TOO_SLOW); }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (rows: never) => void, reject, timer });
      try { worker.postMessage({ id, ...request }); }
      catch { void this.close(); }
    });
  }

  async close(reason = "Search was interrupted. Try again shortly."): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new SearchUnavailable(reason));
    }
    this.pending.clear();
    if (worker) this.stopping = Promise.all([this.stopping, worker.terminate()]).then(() => {});
    await this.stopping;
  }
}
