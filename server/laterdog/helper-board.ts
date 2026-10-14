import { applyHelperUpdate, type Helper, type HelpersSnapshot } from "../../shared/helpers.ts";

export class HelperBoard {
  private threads = new Map<string, { helpers: Helper[]; settledAt?: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  update(threadId: string, helper: Helper): void {
    const before = this.threads.get(threadId);
    const helpers = applyHelperUpdate(before?.helpers ?? [], helper);
    this.threads.set(threadId, { helpers, ...(!helpers.some(row => row.state === "running") ? { settledAt: this.now() } : {}) });
  }
  start(threadId: string): void { this.threads.delete(threadId); }
  fail(threadId: string, activity: string): Helper[] {
    const endedAt = this.now();
    const failed = (this.threads.get(threadId)?.helpers ?? []).filter(helper => helper.state === "running").map((helper): Helper => ({
      ...helper, state: "failed", endedAt, activity,
      ...(helper.members ? { members: helper.members.map(member => member.state === "running" ? { ...member, state: "failed", activity } : member) } : {}),
    }));
    for (const helper of failed) this.update(threadId, helper);
    return failed;
  }
  settle(threadId: string): void {
    const entry = this.threads.get(threadId);
    if (entry && !entry.helpers.some(helper => helper.state === "running")) entry.settledAt = this.now();
  }
  snapshot(visible: (threadId: string) => boolean): HelpersSnapshot {
    for (const [id, entry] of this.threads) if (entry.settledAt !== undefined && this.now() - entry.settledAt >= 10_000) this.threads.delete(id);
    return { helpers: Object.fromEntries([...this.threads].filter(([id]) => visible(id)).map(([id, entry]) => [id, entry.helpers])) };
  }
  running(threadId: string): boolean { return this.threads.get(threadId)?.helpers.some(helper => helper.state === "running") ?? false; }
}
