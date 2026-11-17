import type { NativeRun } from "../../shared/native-runs.ts";
import { liveStep, type LiveStep } from "../../shared/step-words.ts";
import { NativeRunStore, type NativeRunDatabase } from "./native-run-store.ts";

export const LIVE_STEP_THROTTLE_MS = 5_000;

interface Sent { step: LiveStep; at: number }

const same = (a: LiveStep | null, b: LiveStep | null): boolean =>
  a === b || Boolean(a && b && a.id === b.id && a.kind === b.kind && a.startedAt === b.startedAt && a.lastActivityAt === b.lastActivityAt);

export class LiveSteps {
  private readonly sent = new Map<string, Sent>();
  private readonly runOf: (threadId: string) => NativeRun | undefined;
  private readonly now: () => number;

  constructor(runOf: (threadId: string) => NativeRun | undefined, now: () => number = Date.now) {
    this.runOf = runOf;
    this.now = now;
  }

  step(threadId: string): LiveStep | null {
    const next = liveStep(this.runOf(threadId));
    const last = this.sent.get(threadId);
    const at = this.now();
    if (last && !this.free(last, next, at)) return last.step;
    if (next) this.sent.set(threadId, { step: next, at });
    else this.sent.delete(threadId);
    return next;
  }

  due(threadId: string): boolean {
    const next = liveStep(this.runOf(threadId));
    const last = this.sent.get(threadId);
    if (!last) return next !== null;
    return this.free(last, next, this.now()) && !same(last.step, next);
  }

  private free(last: Sent, next: LiveStep | null, at: number): boolean {
    return !next || next.id !== last.step.id || at - last.at >= LIVE_STEP_THROTTLE_MS;
  }
}

export function liveStepsFrom(database: NativeRunDatabase, now?: () => number): LiveSteps {
  const runs = new NativeRunStore(database);
  return new LiveSteps(threadId => runs.live(threadId)[0], now);
}
