import type { NativeRun } from "../../shared/native-runs.ts";

export class NativeRunPublisher {
  private readonly send: (run: NativeRun) => void;
  private readonly intervalMs: number;
  private readonly pending = new Map<string, NativeRun>();
  private readonly sent = new Map<string, { at: number; revision: number }>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(send: (run: NativeRun) => void, intervalMs = 150) {
    this.send = send;
    this.intervalMs = intervalMs;
  }

  publish(run: NativeRun): void {
    const previous = this.sent.get(run.id);
    if (previous && previous.revision >= run.revision) return;
    if (!previous || run.observation !== "live" || Date.now() - previous.at >= this.intervalMs) {
      this.pending.delete(run.id);
      this.deliver(run);
      return;
    }
    if ((this.pending.get(run.id)?.revision ?? -1) < run.revision) this.pending.set(run.id, run);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const updates = [...this.pending.values()];
        this.pending.clear();
        for (const update of updates) this.deliver(update);
      }, this.intervalMs);
      this.timer.unref();
    }
  }

  private deliver(run: NativeRun): void {
    this.sent.delete(run.id);
    this.sent.set(run.id, { at: Date.now(), revision: run.revision });
    while (this.sent.size > 512) this.sent.delete(this.sent.keys().next().value!);
    this.send(run);
  }
}
