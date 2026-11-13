import type { LimitHold } from "./limit-hold.ts";

export type PickupOutcome = "started" | "full" | "waiting" | "needs-you" | "skipped";

export type PickupHold = Pick<LimitHold, "awaitPerson" | "retry" | "hold" | "release" | "waitsOnPerson">;

export function settlePickup(hold: PickupHold, threadId: string, outcome: PickupOutcome | undefined, after: "reset" | "restart"): boolean {
  if (outcome === "needs-you") return hold.awaitPerson(threadId);
  if (outcome === "full") hold.retry(threadId);
  else if (outcome === "waiting") hold.hold(threadId);
  else if (outcome === "started" || after === "restart" || hold.waitsOnPerson(threadId)) hold.release(threadId);
  return false;
}

export function shownWaiting(waiting: Readonly<Record<string, string>>, keep: { carriesOn: (threadId: string) => boolean; waitsOnPerson: (threadId: string) => boolean }): Record<string, string> {
  return Object.fromEntries(Object.entries(waiting).filter(([threadId]) => keep.carriesOn(threadId) && !keep.waitsOnPerson(threadId)));
}

export function usageHeld(waiting: Readonly<Record<string, string>>, waitsOnPerson: (threadId: string) => boolean): string[] {
  return Object.keys(waiting).filter((threadId) => !waitsOnPerson(threadId));
}

export interface HeldChat {
  switchedOff: boolean;
  queued: boolean;
  waitsOnPerson: boolean;
  keptTurn: boolean;
}

export function personWaitStays(chat: HeldChat): boolean {
  return (chat.switchedOff && chat.queued) || (chat.waitsOnPerson && chat.keptTurn);
}
