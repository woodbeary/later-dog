import { describe, expect, it } from "vitest";
import {
  HANDOFF_HARD_CAP_MS, HANDOFF_IDLE_MS, HandoffBudget, continueOffer, endWords, endedForTime, plainDuration, teammateEndLabel,
} from "./handoff-budget.ts";

const limits = { idleMs: HANDOFF_IDLE_MS, hardCapMs: HANDOFF_HARD_CAP_MS, minRunwayMs: 10 * 60_000 };

describe("handoff end words", () => {
  it("says durations the way a person would", () => {
    expect(plainDuration(HANDOFF_HARD_CAP_MS)).toBe("4 hours");
    expect(plainDuration(HANDOFF_IDLE_MS)).toBe("20 minutes");
    expect(plainDuration(60 * 60_000)).toBe("1 hour");
    expect(plainDuration(90 * 60_000)).toBe("1.5 hours");
    expect(plainDuration(60_000)).toBe("1 minute");
    expect(plainDuration(1_000)).toBe("under a minute");
  });
  it("never blames the person for time running out and never says user", () => {
    for (const end of ["interrupted", "deleted", "idle", "capped", "origin", "limit", "restart", "problem"] as const) {
      expect(endWords(end, limits)).not.toMatch(/stopped by|the user|\buser\b/i);
    }
    expect(endWords("capped", limits)).toBe("Ran out of time after 4 hours.");
    expect(endWords("idle", limits)).toBe("Nothing moved for 20 minutes, so later.dog stopped waiting.");
    expect(endWords("person", limits)).toBe("The person stopped this work.");
    expect(endWords("person", limits, true)).toBe("The person stopped this before it started.");
  });
  it("offers Continue in plain words", () => {
    expect(continueOffer("capped", limits)).toBe("Ran out of time after 4 hours. Continue?");
    expect(continueOffer("idle", limits)).toBe("Nothing moved for 20 minutes. Continue?");
    expect(endedForTime("capped")).toBe(true);
    expect(endedForTime("idle")).toBe(true);
    expect(endedForTime("person")).toBe(false);
    expect(endedForTime(undefined)).toBe(false);
  });
  it("labels a teammate's result by what actually happened", () => {
    expect(teammateEndLabel("Scout", "completed", undefined)).toBe("Scout replied");
    expect(teammateEndLabel("Scout", "cancelled", "person")).toBe("Scout stopped");
    expect(teammateEndLabel("Scout", "failed", "capped")).toBe("Scout ran out of time");
    expect(teammateEndLabel("Scout", "failed", "idle")).toBe("Scout ran out of time");
    expect(teammateEndLabel("Scout", "cancelled", "origin")).toBe("Scout never got started");
    expect(teammateEndLabel("Scout", "cancelled", "interrupted")).toBe("Scout was interrupted");
    expect(teammateEndLabel("Scout", "failed", "problem")).toBe("Scout couldn't finish");
    expect(teammateEndLabel("Scout", "failed", undefined)).toBe("Scout couldn't finish");
  });
});

describe("HandoffBudget", () => {
  const root = { id: "r", createdAt: 0 };
  it("measures idle time from the latest sign of progress", () => {
    let now = 0;
    const budget = new HandoffBudget(limits, () => now);
    now = 19 * 60_000;
    expect(budget.idle(root)).toBe(false);
    budget.note("r", now);
    now = 38 * 60_000;
    expect(budget.idle(root)).toBe(false);
    now = 39 * 60_000 + 1;
    expect(budget.idle(root)).toBe(true);
    expect(budget.idle({ ...root, lastProgressAt: now })).toBe(false);
    budget.forget("r");
    expect(budget.idleFor(root)).toBe(now);
  });
  it("keeps the latest progress even when an older reading arrives later", () => {
    let now = 30 * 60_000;
    const budget = new HandoffBudget(limits, () => now);
    budget.note("r", 25 * 60_000);
    budget.note("r", 10 * 60_000);
    expect(budget.idleFor(root)).toBe(5 * 60_000);
  });
  it("trusts a running node that has no reading or that waits on the person, and otherwise uses its latest event", () => {
    const now = 50 * 60_000;
    const budget = new HandoffBudget(limits, () => now);
    expect(budget.runningProgressAt(undefined, 1)).toBe(now);
    expect(budget.runningProgressAt({ at: 2, waiting: true }, 1)).toBe(now);
    expect(budget.runningProgressAt({ at: 40 * 60_000 }, 30 * 60_000)).toBe(40 * 60_000);
    expect(budget.runningProgressAt({}, 30 * 60_000)).toBe(30 * 60_000);
  });
  it("caps the whole tree from when it began and keeps a runway for new work", () => {
    let now = HANDOFF_HARD_CAP_MS - 10 * 60_000;
    const budget = new HandoffBudget(limits, () => now);
    expect(budget.hasRunway(root)).toBe(true);
    expect(budget.pastHardCap(root)).toBe(false);
    now += 1;
    expect(budget.hasRunway(root)).toBe(false);
    expect(budget.refusal(root)).toContain("Time is nearly up for this team task: 10 minutes left of 4 hours");
    now = HANDOFF_HARD_CAP_MS;
    expect(budget.pastHardCap(root)).toBe(true);
    expect(budget.refusal(root)).toContain("under a minute left");
  });
});
