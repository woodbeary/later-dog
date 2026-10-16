import { describe, expect, it } from "vitest";
import { APPROVAL_MODES } from "../../shared/approval-mode.ts";
import { DEFAULT_ROOM_TURN_TIMEOUT_MINUTES } from "../config.ts";
import {
  LONG_WORK_TURN_MINUTES, autoContinuedLine, handoffRunNote, ownerAutoWork, ownersWork, restartLine, roomHandoffResult, roomTurnMinutes,
  runsUnattended, stalledTurnOutcome, stoppedWorkLine, timedOutAgain, turnStallDetail,
} from "./long-work.ts";
import {
  MAX_OWN_THREADS_PER_TURN, MAX_TEAMMATE_THREADS_PER_TURN, OWNER_OWN_THREADS_PER_TURN, OWNER_TEAMMATE_THREADS_PER_TURN, threadsPerTurn,
} from "./work-thread-reuse.ts";

const owner = { sharedWorkspace: false, guestDriven: false };

describe("whose work runs long", () => {
  it("is only the owner's dogs in auto or full access, never a guest's or a shared workspace's", () => {
    expect(APPROVAL_MODES.filter(runsUnattended)).toEqual(["auto", "full"]);
    expect(ownerAutoWork(owner, "auto")).toBe(true);
    expect(ownerAutoWork(owner, "full")).toBe(true);
    expect(ownerAutoWork(owner, "ask")).toBe(false);
    expect(ownerAutoWork(owner, "edits")).toBe(false);
    expect(ownerAutoWork({ ...owner, guestDriven: true }, "auto")).toBe(false);
    expect(ownerAutoWork({ ...owner, sharedWorkspace: true }, "full")).toBe(false);
    expect(ownersWork(owner)).toBe(true);
    expect(ownersWork({ sharedWorkspace: true, guestDriven: false })).toBe(false);
  });
});

describe("room and handoff turn deadline", () => {
  it("gives the owner's auto dogs four hours instead of five minutes", () => {
    expect(DEFAULT_ROOM_TURN_TIMEOUT_MINUTES).toBe(5);
    expect(LONG_WORK_TURN_MINUTES).toBe(240);
    expect(roomTurnMinutes({ configured: 5, override: undefined, longWork: true })).toBe(240);
    expect(roomTurnMinutes({ configured: 5, override: null, longWork: true })).toBe(240);
    expect(roomTurnMinutes({ configured: 600, override: undefined, longWork: true })).toBe(600);
  });
  it("keeps the configured deadline for everyone else and respects a conversation's own limit", () => {
    expect(roomTurnMinutes({ configured: 5, override: undefined, longWork: false })).toBe(5);
    expect(roomTurnMinutes({ configured: 5, override: 30, longWork: true })).toBe(30);
    expect(roomTurnMinutes({ configured: 5, override: 30, longWork: false })).toBe(30);
    expect(roomTurnMinutes({ configured: 5, override: 0, longWork: false })).toBe(5);
  });
});

describe("timeouts are timeouts", () => {
  it("marks a timed-out or stalled room turn as a timeout so it is tried again, in words that never blame the person", () => {
    const timedOut = roomHandoffResult({ outcome: "timed_out" }, "Builder");
    expect(timedOut).toEqual({ ok: false, text: "Builder's turn ran out of time.", timedOut: true });
    expect(roomHandoffResult({ outcome: "stalled" }, "Builder")).toMatchObject({ ok: false, timedOut: true });
    expect(roomHandoffResult({ outcome: "settled", replyText: "done" }, "Builder")).toEqual({ ok: true, text: "done" });
    expect(roomHandoffResult({ outcome: "provider_failed", stopReason: "quota" }, "Builder")).toEqual({ ok: false, text: "quota" });
    expect(roomHandoffResult({}, "Builder")).toEqual({ ok: false, text: "The addressed agent could not run" });
    expect(stalledTurnOutcome("no activity")).toEqual({ ok: false, text: "no activity", timedOut: true });
    expect(timedOutAgain("Builder's turn ran out of time.")).toBe("Builder's turn ran out of time. It was tried again and ran out of time again.");
    expect(timedOutAgain("")).toBe("It was tried again and ran out of time again.");
  });
  it("never tells a timed-out dog that the person stopped it", () => {
    for (const end of ["idle", "capped", "timeout", "ceiling"] as const) {
      expect(stoppedWorkLine(end)).toBe("This work ran out of time. Automatic continuation is cancelled.");
    }
    expect(stoppedWorkLine("restart")).not.toMatch(/you stopped|user/i);
    expect(stoppedWorkLine("api")).toBe("A local tool on this Mac stopped this work. Automatic continuation is cancelled.");
    expect(stoppedWorkLine("person")).toBe("You stopped this work. Automatic continuation is cancelled.");
    expect(stoppedWorkLine(undefined)).toBe("You stopped this work. Automatic continuation is cancelled.");
  });
  it("tells a retried or restarted dog to check what is done before carrying on", () => {
    expect(handoffRunNote({})).toBe("");
    expect(handoffRunNote({ retried: true })).toContain("ran out of time");
    expect(handoffRunNote({ restarted: true, retried: true })).toContain("later.dog restarted");
  });
  it("says why the watchdog stopped a turn", () => {
    const turn = { threadId: "t", botId: "b", startedAt: 0, lastEventAt: 0, waitingOnHuman: false, waitingOnComputer: false, waitingOnHelpers: false };
    expect(turnStallDetail(turn, 20 * 60_000, false)).toBe("no activity for 20 minutes — the turn was stopped");
    expect(turnStallDetail({ ...turn, toolsRunning: new Map([["bash", 0]]) }, 20 * 60_000, true)).toBe("A tool kept running past its time limit, so the turn was stopped");
    expect(turnStallDetail({ ...turn, waitingOnHelpers: true }, 20 * 60_000, false)).toBe("The helpers reached their time limit and were stopped");
  });
});

describe("plain lines after a restart or an automatic continue", () => {
  it("names the work picked back up, or each handoff to send again", () => {
    expect(restartLine([{ name: "Builder", text: "Build it" }], true)).toBe("notice: later.dog restarted while Builder was working, so it picked that work back up.");
    const lost = restartLine([{ name: "Builder", text: "Build\n it" }, { name: "Scout", text: "Find the files" }], false);
    expect(lost).toBe("notice: later.dog restarted while Builder, Scout were working, and that work did not carry over. Re-send: @Builder: Build it; @Scout: Find the files");
    expect(lost.split("\n")).toHaveLength(1);
    expect(autoContinuedLine("idle", 20 * 60_000)).toBe("notice: Nothing moved for 20 minutes, so later.dog picked the work back up.");
  });
});

describe("threads per turn", () => {
  it("lets the owner's dogs open 20 own and 40 teammate threads, and keeps the old limits for anyone else", () => {
    expect(threadsPerTurn(true)).toEqual({ own: 20, teammate: 40 });
    expect(threadsPerTurn(true)).toEqual({ own: OWNER_OWN_THREADS_PER_TURN, teammate: OWNER_TEAMMATE_THREADS_PER_TURN });
    expect(threadsPerTurn(false)).toEqual({ own: MAX_OWN_THREADS_PER_TURN, teammate: MAX_TEAMMATE_THREADS_PER_TURN });
    expect(threadsPerTurn(false)).toEqual({ own: 5, teammate: 15 });
  });
});
