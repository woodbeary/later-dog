import type { WireMessage } from "../../shared/wire.ts";
import type { WatchedTurn } from "../turn-watchdog.ts";
import { continueOffer, type HandoffActivity, type HandoffBudgetLimits, type HandoffEnd } from "./handoff-budget.ts";

type Tool = NonNullable<WireMessage["tool"]>;

export const CONTINUING_NOTICE = "notice: Picking the work back up where it stopped.";

export function continueNoticeTool(rootId: string, end: HandoffEnd, limits: Pick<HandoffBudgetLimits, "idleMs" | "hardCapMs">): Tool {
  return { name: `notice: ${continueOffer(end, limits)}`, ok: true, resume: { handoffId: rootId } };
}

export function continuingNoticeTool(): Tool {
  return { name: CONTINUING_NOTICE, ok: true };
}

export function handoffActivity(watched: WatchedTurn | undefined): HandoffActivity | undefined {
  if (!watched) return undefined;
  return {
    at: watched.lastEventAt,
    waiting: watched.waitingOnHuman || watched.waitingOnComputer || watched.waitingOnHelpers,
  };
}
