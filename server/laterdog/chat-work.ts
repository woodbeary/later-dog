import type { BotActivity, WireWaitingOn } from "../../shared/wire.ts";
import type { WorkState } from "../../shared/work-state.ts";
import type { RoomHandoff } from "../room-handoffs.ts";

const ENDED: ReadonlySet<RoomHandoff["status"]> = new Set(["completed", "failed", "cancelled"]);

export function handoffRunningIn(threadId: string, nodes: Iterable<RoomHandoff>): boolean {
  for (const node of nodes) {
    if (!node.groupId && node.parentId && node.threadId === threadId && node.status === "running") return true;
  }
  return false;
}

export interface HandoffWait {
  waitingForTeammates: boolean;
  waitingOn?: WireWaitingOn[];
}

export function handoffWait(busy: boolean, handoffOpen: boolean, awaited: () => WireWaitingOn[]): HandoffWait {
  if (busy || !handoffOpen) return { waitingForTeammates: false };
  return { waitingForTeammates: true, waitingOn: awaited() };
}

export function handoffWorkDone(threadId: string, nodes: Iterable<RoomHandoff>, personAt: number | undefined): boolean {
  let latest: RoomHandoff | undefined;
  for (const node of nodes) {
    if (node.groupId || node.threadId !== threadId || !node.parentId) continue;
    if (!latest || node.createdAt > latest.createdAt) latest = node;
  }
  if (!latest || (personAt !== undefined && personAt > latest.createdAt)) return false;
  return ENDED.has(latest.status);
}

export interface OlderWorkFields {
  activity?: BotActivity;
  waitingForTeammates: boolean;
  waitingOn?: WireWaitingOn[];
  helpersWorking?: number;
}

const LIVE: ReadonlySet<WorkState["kind"]> = new Set(["running", "retrying", "waiting-for-computer"]);

export interface AliveBehind {
  helpers: number;
  computerJobs: number;
}

export function olderWorkFields(work: WorkState, busy: boolean, activity: BotActivity | undefined, handoff: HandoffWait, alive: AliveBehind = { helpers: 0, computerJobs: 0 }): OlderWorkFields {
  const helpersWorking = busy ? 0 : Math.max(0, alive.helpers) + Math.max(0, alive.computerJobs);
  const shown = work.kind === "needs-you" ? "waiting-on-you"
    : activity === "working" && !LIVE.has(work.kind) ? "idle"
    : activity;
  return {
    ...(shown ? { activity: shown } : {}),
    waitingForTeammates: handoff.waitingForTeammates,
    ...(handoff.waitingOn ? { waitingOn: handoff.waitingOn } : {}),
    ...(helpersWorking ? { helpersWorking } : {}),
  };
}
