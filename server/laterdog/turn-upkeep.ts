import type { HomeProcess } from "./home-processes.ts";
import { REAP_GRACE_MS } from "./process-reaper.ts";
import { leftoversLine } from "./turn-leftovers.ts";

export const TURN_SETTLE_MS = 3_000;

export interface TurnUpkeepDeps {
  atWork(threadId: string): boolean;
  endLeftovers(mark: string): HomeProcess[];
  emptyTemp?: (threadId: string) => void;
  log(line: string): void;
  later?: (run: () => void, ms: number) => void;
}

export function turnUpkeep(deps: TurnUpkeepDeps): (event: { type: string; threadId: string }) => void {
  const later = deps.later ?? ((run, ms) => setTimeout(run, ms).unref());
  return (event) => {
    if (event.type !== "turn.completed" && event.type !== "session.exited") return;
    const threadId = event.threadId;
    later(() => {
      if (deps.atWork(threadId)) return;
      const ended = deps.endLeftovers(threadId);
      if (ended.length) deps.log(leftoversLine(threadId, ended));
      later(() => { if (!deps.atWork(threadId)) deps.emptyTemp?.(threadId); }, ended.length ? REAP_GRACE_MS + 1_000 : 0);
    }, TURN_SETTLE_MS);
  };
}
