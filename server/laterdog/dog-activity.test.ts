import { describe, expect, it } from "vitest";
import { dayKey, dogActivity, recentDays, TURN_CAP_MS } from "./dog-activity.ts";

const TZ = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-10-30T20:00:00Z");

describe("a dog's activity", () => {
  it("counts days in the home's own time zone, oldest first, ending today", () => {
    expect(dayKey(at("2026-10-31T03:00:00Z"), TZ)).toBe("2026-10-30");
    expect(recentDays(NOW, 3, TZ)).toEqual(["2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(recentDays(at("2026-11-02T20:00:00Z"), 3, TZ)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  it("counts what you sent, its replies and the time from each request to its last output", () => {
    const thread = [
      { role: "user", kind: "text", at: at("2026-10-30T15:00:00Z") },
      { role: "bot", kind: "activity", at: at("2026-10-30T15:01:00Z") },
      { role: "bot", kind: "text", at: at("2026-10-30T15:05:00Z") },
      { role: "user", kind: "text", at: at("2026-10-29T16:00:00Z") },
      { role: "bot", kind: "text", at: at("2026-10-29T16:00:30Z") },
      { role: "bot", kind: "secret", at: at("2026-10-29T16:02:00Z") },
    ];
    const activity = dogActivity({ threads: [thread], turnTimes: [at("2026-10-30T15:05:00Z"), at("2026-10-29T16:02:00Z")], now: NOW, days: 3, timeZone: TZ });
    expect(activity.today).toBe("2026-10-30");
    expect(activity.days).toEqual([
      { day: "2026-10-28", sent: 0, replies: 0, turns: 0, workedSeconds: 0 },
      { day: "2026-10-29", sent: 1, replies: 1, turns: 1, workedSeconds: 120 },
      { day: "2026-10-30", sent: 1, replies: 1, turns: 1, workedSeconds: 300 },
    ]);
    expect(activity.totals).toEqual({ sent: 2, replies: 2, turns: 2, workedSeconds: 420 });
  });

  it("caps a turn left running and ignores messages outside the window", () => {
    const thread = [
      { role: "user", kind: "text", at: at("2026-10-30T09:00:00Z") },
      { role: "bot", kind: "text", at: at("2026-10-30T19:00:00Z") },
      { role: "user", kind: "text", at: at("2026-09-01T09:00:00Z") },
      { role: "bot", kind: "text", at: at("2026-09-01T09:01:00Z") },
    ];
    const activity = dogActivity({ threads: [thread], turnTimes: [at("2026-09-01T09:01:00Z")], now: NOW, days: 2, timeZone: TZ });
    expect(activity.totals).toEqual({ sent: 1, replies: 1, turns: 0, workedSeconds: TURN_CAP_MS / 1000 });
  });

  it("does not count a dog's own messages before any request as work", () => {
    const thread = [{ role: "bot", kind: "text", at: at("2026-10-30T10:00:00Z") }];
    expect(dogActivity({ threads: [thread], turnTimes: [], now: NOW, days: 1, timeZone: TZ }).totals).toEqual({ sent: 0, replies: 1, turns: 0, workedSeconds: 0 });
  });
});
