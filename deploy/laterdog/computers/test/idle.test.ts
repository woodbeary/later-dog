import { describe, expect, it } from "vitest";
import { HEALTH_CHECK_MS, MINUTE, decideIdle, idlePolicy, inactivityTimeoutMs, maxComputers } from "../src/idle";

const policy = { idleSleepMs: 15 * MINUTE, maxAwakeMs: 8 * 60 * MINUTE };
const T0 = 1_800_000_000_000;
const base = { ...policy, now: T0, lastActiveAt: T0, awakeSince: T0, viewers: 0, inFlight: 0 };

describe("decideIdle", () => {
  it("stays awake while recently active, checking again at most five minutes out", () => {
    expect(decideIdle({ ...base, now: T0 + MINUTE })).toEqual({ sleep: false, checkAt: T0 + MINUTE + HEALTH_CHECK_MS });
    expect(decideIdle({ ...base, now: T0 + 12 * MINUTE })).toEqual({ sleep: false, checkAt: T0 + 15 * MINUTE });
  });

  it("sleeps once idle for the configured time", () => {
    expect(decideIdle({ ...base, now: T0 + 15 * MINUTE })).toEqual({ sleep: true, reason: "idle" });
    expect(decideIdle({ ...base, now: T0 + 40 * MINUTE })).toEqual({ sleep: true, reason: "idle" });
  });

  it("measures idleness from the last activity, not from waking", () => {
    expect(decideIdle({ ...base, lastActiveAt: T0 + 10 * MINUTE, now: T0 + 20 * MINUTE })).toEqual({ sleep: false, checkAt: T0 + 25 * MINUTE });
  });

  it("stays awake with an open viewer or a request in flight, however long idle", () => {
    expect(decideIdle({ ...base, viewers: 1, now: T0 + 60 * MINUTE })).toEqual({ sleep: false, checkAt: T0 + 61 * MINUTE });
    expect(decideIdle({ ...base, inFlight: 2, now: T0 + 60 * MINUTE })).toEqual({ sleep: false, checkAt: T0 + 61 * MINUTE });
  });

  it("sleeps after the maximum awake time even with a viewer open", () => {
    const now = T0 + 8 * 60 * MINUTE;
    expect(decideIdle({ ...base, viewers: 3, inFlight: 1, lastActiveAt: now, now })).toEqual({ sleep: true, reason: "max_awake" });
  });

  it("never schedules the next check past the maximum awake time", () => {
    const now = T0 + 8 * 60 * MINUTE - 30_000;
    expect(decideIdle({ ...base, viewers: 1, lastActiveAt: now, now })).toEqual({ sleep: false, checkAt: T0 + 8 * 60 * MINUTE });
  });
});

describe("a free trial's budget", () => {
  it("sleeps once the trial's minutes run out, even with a viewer open", () => {
    expect(decideIdle({ ...base, budgetEndsAt: T0 + 10 * MINUTE, now: T0 + 10 * MINUTE })).toEqual({ sleep: true, reason: "budget" });
    const now = T0 + 10 * MINUTE;
    expect(decideIdle({ ...base, viewers: 1, inFlight: 1, lastActiveAt: now, budgetEndsAt: now, now })).toEqual({ sleep: true, reason: "budget" });
  });

  it("checks again exactly when the minutes run out", () => {
    expect(decideIdle({ ...base, budgetEndsAt: T0 + 2 * MINUTE, now: T0 + MINUTE })).toEqual({ sleep: false, checkAt: T0 + 2 * MINUTE });
    expect(decideIdle({ ...base, viewers: 1, budgetEndsAt: T0 + 90_000, now: T0 + MINUTE })).toEqual({ sleep: false, checkAt: T0 + 90_000 });
  });

  it("names the maximum awake time when both are reached", () => {
    const now = T0 + 8 * 60 * MINUTE;
    expect(decideIdle({ ...base, budgetEndsAt: now - MINUTE, now })).toEqual({ sleep: true, reason: "max_awake" });
  });
});

describe("configuration", () => {
  it("defaults to 15 idle minutes, 8 awake hours and 10 computers", () => {
    expect(idlePolicy({})).toEqual(policy);
    expect(maxComputers({})).toBe(10);
  });

  it("reads the vars and keeps them in bounds", () => {
    expect(idlePolicy({ IDLE_SLEEP_MINUTES: "5", MAX_AWAKE_HOURS: "2" })).toEqual({ idleSleepMs: 5 * MINUTE, maxAwakeMs: 120 * MINUTE });
    expect(idlePolicy({ IDLE_SLEEP_MINUTES: "0", MAX_AWAKE_HOURS: "1000" })).toEqual({ idleSleepMs: MINUTE, maxAwakeMs: 72 * 60 * MINUTE });
    expect(idlePolicy({ IDLE_SLEEP_MINUTES: "soon", MAX_AWAKE_HOURS: " " })).toEqual(policy);
    expect(maxComputers({ MAX_COMPUTERS: "3" })).toBe(3);
    expect(maxComputers({ MAX_COMPUTERS: "2.9" })).toBe(2);
    expect(maxComputers({ MAX_COMPUTERS: "-4" })).toBe(0);
  });

  it("keeps the platform's inactivity timeout beyond the idle policy and within six hours", () => {
    expect(inactivityTimeoutMs(policy)).toBe(60 * MINUTE);
    const longest = idlePolicy({ IDLE_SLEEP_MINUTES: "100000" });
    expect(longest.idleSleepMs).toBe(240 * MINUTE);
    expect(inactivityTimeoutMs(longest)).toBe(285 * MINUTE);
    expect(inactivityTimeoutMs({ idleSleepMs: 24 * 60 * MINUTE, maxAwakeMs: policy.maxAwakeMs })).toBe(6 * 60 * MINUTE);
  });
});
