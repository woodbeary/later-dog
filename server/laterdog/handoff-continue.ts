import type { WireMessage } from "../../shared/wire.ts";
import { toolRunningSince, type WatchedTurn } from "../turn-watchdog.ts";
import { continueOffer, endWords, type HandoffActivity, type HandoffBudgetLimits, type HandoffEnd } from "./handoff-budget.ts";

type Tool = NonNullable<WireMessage["tool"]>;

export const CONTINUING_NOTICE = "notice: Picking the work back up where it stopped.";

export function continueNoticeTool(rootId: string, end: HandoffEnd, limits: Pick<HandoffBudgetLimits, "idleMs" | "hardCapMs" | "ceilingMs">): Tool {
  if (end === "ceiling") return { name: `notice: ${endWords(end, limits)}`, ok: true };
  return { name: `notice: ${continueOffer(end, limits)}`, ok: true, resume: { handoffId: rootId } };
}

export function continuingNoticeTool(): Tool {
  return { name: CONTINUING_NOTICE, ok: true };
}

export function handoffActivity(watched: WatchedTurn | undefined): HandoffActivity | undefined {
  if (!watched) return undefined;
  return {
    at: watched.lastEventAt,
    waiting: watched.waitingOnHuman || watched.waitingOnComputer || watched.waitingOnHelpers || toolRunningSince(watched) !== undefined,
  };
}
