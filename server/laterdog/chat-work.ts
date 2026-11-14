import type { BotActivity, WireWaitingOn } from "../../shared/wire.ts";
import type { WorkState } from "../../shared/work-state.ts";
import { awaitsReply, type RoomHandoff } from "../room-handoffs.ts";

const ENDED: ReadonlySet<RoomHandoff["status"]> = new Set(["completed", "failed", "cancelled"]);

export interface DirectHandoffFacts {
  awaited: RoomHandoff[];
  working: boolean;
}

export function directHandoffFacts(threadId: string, nodes: Iterable<RoomHandoff>): DirectHandoffFacts {
  const all = [...nodes];
  const byId = new Map(all.map((node) => [node.id, node]));
  const awaited: RoomHandoff[] = [];
  let working = false;
  for (const node of all) {
    if (ENDED.has(node.status) || !node.parentId) continue;
    if (!node.groupId && node.threadId === threadId && node.status === "running") working = true;
    const parent = byId.get(node.parentId);
    if (awaitsReply(node) && parent && !parent.groupId && parent.threadId === threadId) awaited.push(node);
  }
  return { awaited, working };
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

export function olderWorkFields(work: WorkState, busy: boolean, activity: BotActivity | undefined, waitingOn: WireWaitingOn[] | undefined, alive: AliveBehind = { helpers: 0, computerJobs: 0 }): OlderWorkFields {
  const waiting = work.kind === "waiting-on-dog";
  const helpersWorking = busy ? 0 : Math.max(0, alive.helpers) + Math.max(0, alive.computerJobs);
  const shown = work.kind === "needs-you" ? "waiting-on-you"
    : activity === "working" && !LIVE.has(work.kind) ? "idle"
    : activity;
  return {
    ...(shown ? { activity: shown } : {}),
    waitingForTeammates: waiting,
    ...(!busy && waitingOn?.length ? { waitingOn } : {}),
    ...(helpersWorking ? { helpersWorking } : {}),
  };
}
