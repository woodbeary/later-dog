import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { effectiveRoomTurnTimeoutMinutes } from "../room-turn-timeout.ts";
import { toolRunningSince, type WatchedTurn } from "../turn-watchdog.ts";
import { plainDuration, type HandoffEnd } from "./handoff-budget.ts";

export const LONG_WORK_TURN_MINUTES = 240;

export interface WorkOwner {
  sharedWorkspace: boolean;
  guestDriven: boolean;
}

export interface HandoffRunResult {
  ok: boolean;
  text: string;
  timedOut?: boolean;
}

export function ownersWork(owner: WorkOwner): boolean {
  return !owner.sharedWorkspace && !owner.guestDriven;
}

export function runsUnattended(mode: ApprovalMode): boolean {
  return mode === "auto" || mode === "full";
}

export function ownerAutoWork(owner: WorkOwner, mode: ApprovalMode): boolean {
  return ownersWork(owner) && runsUnattended(mode);
}

export function roomTurnMinutes(input: { configured: number; override: number | null | undefined; longWork: boolean }): number {
  const chosen = effectiveRoomTurnTimeoutMinutes(Number.NaN, input.override);
  if (!Number.isNaN(chosen)) return chosen;
  return input.longWork ? Math.max(input.configured, LONG_WORK_TURN_MINUTES) : input.configured;
}

export function roomHandoffResult(
  result: { outcome?: string; stopReason?: string | null; replyText?: string },
  name: string,
): HandoffRunResult {
  if (result.outcome === "timed_out" || result.outcome === "stalled") {
    const words = result.outcome === "timed_out" ? `${name}'s turn ran out of time.` : `${name} showed no activity for too long.`;
    return { ok: false, text: result.stopReason || words, timedOut: true };
  }
  return {
    ok: result.outcome === "settled",
    text: result.stopReason || result.replyText || result.outcome || "The addressed agent could not run",
  };
}

const RETRY_NOTE = "[Your last turn on this ran out of time. Check what is already done, then carry on from where it stopped.]";
const RESTART_NOTE = "[later.dog restarted while you were working on this. Check what is already done, then carry on from where it stopped.]";

export function handoffRunNote(node: { retried?: boolean; restarted?: boolean }): string {
  if (node.restarted) return `\n\n${RESTART_NOTE}`;
  if (node.retried) return `\n\n${RETRY_NOTE}`;
  return "";
}

export function timedOutAgain(text: string): string {
  const said = text.trim();
  return `${said ? `${said} ` : ""}It was tried again and ran out of time again.`;
}

export function stoppedWorkLine(by: HandoffEnd | undefined): string {
  if (by === "api") return "A local tool on this Mac stopped this work. Automatic continuation is cancelled.";
  if (by === "idle" || by === "capped" || by === "timeout" || by === "ceiling") return "This work ran out of time. Automatic continuation is cancelled.";
  if (by === "restart") return "later.dog restarted while this was running. Automatic continuation is cancelled.";
  return "You stopped this work. Automatic continuation is cancelled.";
}

export function turnStallDetail(turn: WatchedTurn, stallMs: number, toolOverran: boolean): string {
  if (turn.waitingOnHelpers) return "The helpers reached their time limit and were stopped";
  if (toolOverran && toolRunningSince(turn) !== undefined) return "A tool kept running past its time limit, so the turn was stopped";
  return `no activity for ${Math.round(stallMs / 60_000)} minutes — the turn was stopped`;
}

export function stalledTurnOutcome(detail: string): HandoffRunResult {
  return { ok: false, text: detail, timedOut: true };
}

export interface LostHandoff {
  name: string;
  text: string;
}

export function restartLine(lost: readonly LostHandoff[], resumed: boolean): string {
  const names = [...new Set(lost.map(item => item.name))];
  const who = names.length ? names.join(", ") : "your teammates";
  if (resumed) return `notice: later.dog restarted while ${who} ${names.length === 1 ? "was" : "were"} working, so it picked that work back up.`;
  const items = lost.map(item => `@${item.name}: ${item.text.replace(/\s+/g, " ").trim().slice(0, 120)}`).join("; ");
  return `notice: later.dog restarted while ${who} ${names.length === 1 ? "was" : "were"} working, and that work did not carry over. Re-send: ${items}`;
}

export function autoContinuedLine(end: HandoffEnd, idleMs: number): string {
  if (end === "idle") return `notice: Nothing moved for ${plainDuration(idleMs)}, so later.dog picked the work back up.`;
  return "notice: Picking the work back up where it stopped.";
}
