import type { NativeRun, NativeRunList } from "../../shared/native-runs.ts";
import type { HistoryOperation } from "../../shared/history-shard-types.ts";

export class HistoryLiveCache {
  private pages = new Map<string, string>();
  private bytes = 0;
  private pending = new Map<string, Promise<void>>();

  async preload(
    threads: readonly string[],
    load: (threads: string[]) => Promise<Array<{ threadId: string; result: NativeRunList }>>,
  ): Promise<void> {
    const missing = Array.from(new Set(threads)).filter((thread) => !this.pages.has(thread));
    const fresh = missing.filter((thread) => !this.pending.has(thread));
    if (fresh.length) {
      const batch = Promise.resolve()
        .then(() => load(fresh))
        .then((rows) => {
          for (const { threadId, result } of rows)
            if (this.pending.get(threadId) === batch) this.save(threadId, result);
        })
        .finally(() => {
          for (const thread of fresh) if (this.pending.get(thread) === batch) this.pending.delete(thread);
        });
      for (const thread of fresh) this.pending.set(thread, batch);
    }
    await Promise.all(new Set(missing.map((thread) => this.pending.get(thread))));
  }

  private remove(thread: string): string | undefined {
    this.pending.delete(thread);
    const raw = this.pages.get(thread);
    if (raw !== undefined) {
      this.bytes -= Buffer.byteLength(raw);
      this.pages.delete(thread);
    }
    return raw;
  }

  private save(thread: string, page: NativeRunList): void {
    if (page.nextCursor || page.historyIncomplete || page.runs.length > 100) return;
    const raw = JSON.stringify(page),
      size = Buffer.byteLength(raw);
    if (size > 256 * 1024) return;
    this.remove(thread);
    this.pages.set(thread, raw);
    this.bytes += size;
    while (this.bytes > 4 * 1024 * 1024 || this.pages.size > 1024) this.remove(this.pages.keys().next().value!);
  }

  invalidate(threads?: readonly string[]): void {
    if (threads) for (const thread of threads) this.remove(thread);
    else {
      this.pending.clear();
      this.pages.clear();
      this.bytes = 0;
    }
  }

  execute<T>(thread: string, op: HistoryOperation, perform: () => T): T {
    if (op.op === "native.livePage" && !op.before) {
      const raw = this.pages.get(thread);
      if (raw !== undefined) return JSON.parse(raw) as T;
      const result = perform();
      this.save(thread, result as NativeRunList);
      return result;
    }
    if (op.op === "native.observe" || op.op === "native.interrupt") {
      const previous = this.remove(thread);
      const result = perform();
      const run = result as NativeRun | null;
      if (previous !== undefined && run?.threadId === thread) {
        const before = JSON.parse(previous) as NativeRunList;
        const runs = before.runs.filter((prior) => prior.id !== run.id);
        if (run.observation === "live") runs.push(run);
        runs.sort((a, b) => b.startedAt - a.startedAt || Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)));
        this.save(thread, { runs });
      }
      return result;
    }
    if (["native.prune", "native.recover", "messages.delete"].includes(op.op)) this.remove(thread);
    return perform();
  }
}
