import { randomUUID } from "node:crypto";

export const MAC_RELAY_INSTANCE_ID = "mac-relay";
export const MAC_RELAY_TIMEOUT_MS = 10 * 60_000;
export const MAC_RELAY_OFFLINE_RESULT = "This dog's Mac isn't relaying right now. Open later.dog Dev on that Mac.";

export type MacRelayJob = { id: string; botId: string; threadId: string; text: string; createdAt: number };
type Pending = { job: MacRelayJob; resolve: (text: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class MacRelayQueue {
  private readonly queued = new Map<string, Pending[]>();
  private readonly leased = new Map<string, Pending>();

  requestTurn(botId: string, threadId: string, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const job: MacRelayJob = { id: randomUUID(), botId, threadId, text, createdAt: Date.now() };
      const timer = setTimeout(() => this.timeout(job.id), MAC_RELAY_TIMEOUT_MS);
      const pending: Pending = { job, resolve, reject, timer };
      const forBot = this.queued.get(botId) ?? [];
      forBot.push(pending);
      this.queued.set(botId, forBot);
    });
  }

  private timeout(jobId: string) {
    for (const [botId, list] of this.queued) {
      const at = list.findIndex((pending) => pending.job.id === jobId);
      if (at === -1) continue;
      const [pending] = list.splice(at, 1);
      if (list.length === 0) this.queued.delete(botId);
      pending?.reject(Object.assign(new Error(MAC_RELAY_OFFLINE_RESULT), { status: 409 }));
      return;
    }
    const pending = this.leased.get(jobId);
    if (pending) {
      this.leased.delete(jobId);
      pending.reject(Object.assign(new Error(MAC_RELAY_OFFLINE_RESULT), { status: 409 }));
    }
  }

  nextJob(botId: string): MacRelayJob | null {
    const forBot = this.queued.get(botId);
    if (!forBot || forBot.length === 0) return null;
    const pending = forBot.shift()!;
    if (forBot.length === 0) this.queued.delete(botId);
    this.leased.set(pending.job.id, pending);
    return pending.job;
  }

  completeJob(jobId: string, text: string): boolean {
    const pending = this.leased.get(jobId);
    if (!pending) return false;
    this.leased.delete(jobId);
    clearTimeout(pending.timer);
    pending.resolve(text);
    return true;
  }

  failJob(jobId: string, message: string): boolean {
    const pending = this.leased.get(jobId);
    if (!pending) return false;
    this.leased.delete(jobId);
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
    return true;
  }

  pendingCount(botId: string): number {
    return this.queued.get(botId)?.length ?? 0;
  }
}
