import type { NativeRun, NativeRunList } from "../../shared/native-runs.ts";
import type { HistoryOperation } from "../../shared/history-shard-types.ts";

export class HistoryLiveCache {
  private pages = new Map<string, string>();
  private bytes = 0;

  private remove(thread: string): string | undefined {
    const raw = this.pages.get(thread);
    if (raw !== undefined) {
      this.bytes -= Buffer.byteLength(raw);
      this.pages.delete(thread);
    }
    return raw;
  }

  private save(thread: string, page: NativeRunList): void {
    if (page.nextCursor || page.historyIncomplete || page.runs.length > 1) return;
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
        if (!before.runs.length || before.runs[0].id === run.id)
          this.save(thread, { runs: run.observation === "live" ? [run] : [] });
      }
      return result;
    }
    if (["native.prune", "native.recover", "messages.delete"].includes(op.op)) this.remove(thread);
    return perform();
  }
}
