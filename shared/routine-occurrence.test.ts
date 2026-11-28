import { describe, expect, it } from "vitest";

import { dueOccurrence, localClock, nextOccurrence, zoneClock, type RoutineSchedule } from "./routine-occurrence.ts";

const at = (iso: string) => Date.parse(iso);

describe("schedule maths in a named time zone", () => {
  const pacific = zoneClock("America/Los_Angeles");

  it("reads wall time in the zone", () => {
    expect(pacific.wall(at("2026-11-27T17:30:00Z"))).toEqual({ year: 2026, month: 10, day: 27, weekday: 5, hour: 9, minute: 30 });
    expect(pacific.instant(2026, 10, 27, 9, 30)).toBe(at("2026-11-27T17:30:00Z"));
  });

  it("finds the next daily run in the zone, across a daylight-saving change", () => {
    const daily: RoutineSchedule = { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] };
    expect(nextOccurrence(daily, at("2026-11-27T12:00:00Z"), pacific)).toBe(at("2026-11-27T17:00:00Z"));
    expect(nextOccurrence(daily, at("2026-03-07T18:00:00Z"), pacific)).toBe(at("2026-03-08T16:00:00Z"));
    expect(nextOccurrence(daily, at("2026-10-31T17:00:00Z"), pacific)).toBe(at("2026-11-01T17:00:00Z"));
  });

  it("keeps weekdays to the zone's calendar", () => {
    const monday: RoutineSchedule = { type: "daily", time: "20:00", weekdays: [1] };
    expect(nextOccurrence(monday, at("2026-11-27T12:00:00Z"), pacific)).toBe(at("2026-12-01T04:00:00Z"));
  });

  it("applies an interval window in the zone", () => {
    const schedule: RoutineSchedule = { type: "interval", everyMinutes: 60, anchorAt: at("2026-11-01T00:00:00Z"), window: { start: "09:00", end: "17:00" } };
    expect(nextOccurrence(schedule, at("2026-11-27T02:00:00Z"), pacific)).toBe(at("2026-11-27T17:00:00Z"));
  });

  it("matches the local clock when the zone is the process zone", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const own = zoneClock(zone);
    for (const time of ["07:15", "02:30", "01:30", "23:59"]) {
      const daily: RoutineSchedule = { type: "daily", time, weekdays: [0, 1, 3, 5] };
      for (let start = at("2026-01-01T00:00:00Z"); start < at("2027-01-01T00:00:00Z"); start += 7 * 60 * 60_000) {
        expect(nextOccurrence(daily, start, own)).toBe(nextOccurrence(daily, start, localClock));
      }
    }
  });
});

describe("due occurrences", () => {
  it("moves an interval to its latest occurrence and marks long-late runs missed", () => {
    const schedule: RoutineSchedule = { type: "interval", everyMinutes: 10, anchorAt: at("2026-11-27T00:00:00Z") };
    expect(dueOccurrence(schedule, at("2026-11-27T01:00:00Z"), at("2026-11-27T01:25:00Z"))).toEqual({
      scheduledFor: at("2026-11-27T01:20:00Z"),
      nextRunAt: at("2026-11-27T01:30:00Z"),
      missed: false,
    });
    const once: RoutineSchedule = { type: "once", at: at("2026-11-26T00:00:00Z") };
    expect(dueOccurrence(once, once.at, at("2026-11-27T01:00:00Z"))).toEqual({ scheduledFor: once.at, nextRunAt: null, missed: true });
  });
});
