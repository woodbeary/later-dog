import { personWaitLog } from "./account-needs-you.ts";

export const USAGE_WATCH_MS = 2 * 60_000;
export const USAGE_REFRESH_MS = 5 * 60_000;

export interface UsageWatchHost {
  held(): readonly string[];
  stranded(): readonly string[];
  refresh(): Promise<void>;
  recheck(): void;
  wake(threadId: string): "needs-you" | void;
  now?: () => number;
  log?: (line: string) => void;
}

export interface UsageWatchPlan {
  refresh: boolean;
  wake: string[];
}

export function planUsageWatch(input: { held: readonly string[]; stranded: readonly string[]; lastRefreshAt: number | undefined; now: number; refreshMs?: number }): UsageWatchPlan {
  const waiting = input.held.length + input.stranded.length > 0;
  const due = input.lastRefreshAt === undefined || input.now - input.lastRefreshAt >= (input.refreshMs ?? USAGE_REFRESH_MS);
  const held = new Set(input.held);
  return { refresh: waiting && due, wake: [...new Set(input.stranded)].filter((threadId) => !held.has(threadId)) };
}

const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createUsageWatch(host: UsageWatchHost, options: { everyMs?: number; refreshMs?: number } = {}) {
  const now = host.now ?? Date.now;
  const log = host.log ?? ((line: string) => console.info(line));
  let lastRefreshAt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<UsageWatchPlan> | undefined;
  const onPerson = personWaitLog(log);

  const run = async (): Promise<UsageWatchPlan> => {
    const plan = planUsageWatch({ held: host.held(), stranded: host.stranded(), lastRefreshAt, now: now(), refreshMs: options.refreshMs });
    if (plan.refresh) {
      lastRefreshAt = now();
      try {
        await host.refresh();
      } catch (error) {
        log(`usage watch: could not read account usage: ${reasonOf(error)}`);
      }
      host.recheck();
    }
    onPerson.keepOnly(plan.wake);
    for (const threadId of plan.wake) {
      try {
        if (host.wake(threadId) === "needs-you") onPerson.waiting(threadId, `usage watch: ${threadId} waits for the person to sign in or turn its account back on`);
        else if (!onPerson.over(threadId, `usage watch: ${threadId} no longer waits for the person; checked it again`)) {
          log(`usage watch: ${threadId} was waiting for usage with nothing checking it; checked it again`);
        }
      } catch (error) {
        log(`usage watch: ${threadId} could not be checked: ${reasonOf(error)}`);
      }
    }
    return plan;
  };

  return {
    tick(): Promise<UsageWatchPlan> {
      running ??= run().finally(() => { running = undefined; });
      return running;
    },
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void this.tick(); }, options.everyMs ?? USAGE_WATCH_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type UsageWatch = ReturnType<typeof createUsageWatch>;
