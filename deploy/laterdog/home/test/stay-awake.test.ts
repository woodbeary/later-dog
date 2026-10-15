import { describe, expect, it } from "vitest";
import { MIN_WAKE_DELAY_MS, WAKE_EARLY_MS, type HomeActivity } from "../src/activity.ts";
import {
  DUE_SOON_MS, HOLD_STEP_MS, NO_WORK_HOLD, nextUsualStart, noteRequest, parseRhythm, parseWorkHold, PERSON_WAKE_EARLY_MS,
  RHYTHM_DAYS, stayDecision, USUAL_HOURS_MAX, usualHours, WORK_DAY_MS, WORK_STRETCH_MS, type Rhythm, type WorkHold,
} from "../src/stay-awake.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const TODAY = Math.floor(NOW / DAY);
const MIDNIGHT = TODAY * DAY;
const IDLE: HomeActivity = { busy: false, nextAt: null, work: [] };
const WORKING: HomeActivity = { busy: true, nextAt: null, work: ["turn"] };

function usedAt(times: Array<[daysAgo: number, hour: number]>): Rhythm {
  return times.reduce<Rhythm>((rhythm, [daysAgo, hour]) => noteRequest(rhythm, MIDNIGHT - daysAgo * DAY + hour * HOUR + 20 * MINUTE) ?? rhythm, []);
}

function everyDay(days: number, hours: number[]): Array<[number, number]> {
  return Array.from({ length: days }, (_, day) => hours.map((hour): [number, number] => [day + 1, hour])).flat();
}

function bits(mask: number): number[] {
  return Array.from({ length: 24 }, (_, hour) => hour).filter((hour) => mask & (1 << hour));
}

function decide(activity: HomeActivity | null, options: { rhythm?: Rhythm; hold?: WorkHold; now?: number } = {}) {
  return stayDecision({ activity, rhythm: options.rhythm ?? [], hold: options.hold ?? NO_WORK_HOLD, now: options.now ?? NOW });
}

describe("staying awake for a dog's work", () => {
  it("stays a step at a time while the home names work, and counts that time against the day", () => {
    expect(NOW - MIDNIGHT).toBe(8 * HOUR);
    const first = decide(WORKING);
    expect(first).toEqual({ stay: true, reason: "work", hold: { day: TODAY, usedMs: HOLD_STEP_MS, since: NOW } });
    const second = decide(WORKING, { hold: first.hold, now: NOW + HOLD_STEP_MS });
    expect(second).toEqual({ stay: true, reason: "work", hold: { day: TODAY, usedMs: 2 * HOLD_STEP_MS, since: NOW } });
  });

  it("stays for a routine due within a quarter hour rather than sleeping and waking again", () => {
    expect(decide({ busy: false, nextAt: NOW + 10_000, work: [] })).toMatchObject({ stay: true, reason: "due" });
    expect(decide({ busy: false, nextAt: NOW + DUE_SOON_MS, work: [] })).toMatchObject({ stay: true, reason: "due" });
  });

  it("sleeps until a minute before a later routine", () => {
    expect(decide({ busy: false, nextAt: NOW + HOUR, work: [] })).toEqual({
      stay: false, routineWakeAt: NOW + HOUR - WAKE_EARLY_MS, personWakeAt: null, hold: { day: TODAY, usedMs: 0, since: null }, capped: null,
    });
  });

  it("sleeps with nothing to wake for when nothing is going on or the home doesn't answer", () => {
    expect(decide(IDLE)).toMatchObject({ stay: false, routineWakeAt: null, personWakeAt: null, capped: null });
    expect(decide(null)).toMatchObject({ stay: false, routineWakeAt: null, personWakeAt: null, capped: null });
  });

  it("sleeps anyway after six hours in a row of work without the person, still waking for the next routine", () => {
    const hold = { day: TODAY, usedMs: WORK_STRETCH_MS, since: NOW - WORK_STRETCH_MS };
    expect(decide({ busy: true, nextAt: NOW + 2 * HOUR, work: ["cloud_job"] }, { hold })).toEqual({
      stay: false, routineWakeAt: NOW + 2 * HOUR - WAKE_EARLY_MS, personWakeAt: null, hold: { ...hold, since: null }, capped: "stretch",
    });
    expect(decide(WORKING, { hold: { ...hold, since: NOW - WORK_STRETCH_MS + MINUTE } })).toMatchObject({ stay: true, reason: "work" });
  });

  it("sleeps anyway after twelve hours of work in a day, and starts the count again the next day", () => {
    const spent = { day: TODAY, usedMs: WORK_DAY_MS, since: null };
    expect(decide(WORKING, { hold: spent })).toMatchObject({ stay: false, capped: "day" });
    expect(decide({ busy: false, nextAt: NOW + 30_000, work: [] }, { hold: spent })).toMatchObject({ stay: false, capped: "day", routineWakeAt: NOW + MIN_WAKE_DELAY_MS });
    expect(decide(WORKING, { hold: spent, now: NOW + DAY })).toEqual({ stay: true, reason: "work", hold: { day: TODAY + 1, usedMs: HOLD_STEP_MS, since: NOW + DAY } });
  });

  it("keeps the stretch going across midnight", () => {
    const lateNight = MIDNIGHT + DAY - HOUR;
    const hold = { day: TODAY, usedMs: 5 * HOUR, since: lateNight - 5 * HOUR - 30 * MINUTE };
    expect(decide(WORKING, { hold, now: lateNight + HOUR })).toMatchObject({ stay: false, capped: "stretch" });
  });
});

describe("learning the person's usual hours", () => {
  it("counts an hour as usual once the person used the home in it on three days of the last two weeks", () => {
    const rhythm = usedAt([[1, 8], [2, 8], [3, 8], [1, 20], [2, 20], [5, 13]]);
    expect(bits(usualHours(rhythm, NOW))).toEqual([8]);
  });

  it("keeps at most ten usual hours, the ones used on the most days", () => {
    const rhythm = usedAt([...everyDay(5, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]), ...everyDay(7, [18, 19])]);
    const usual = bits(usualHours(rhythm, NOW));
    expect(usual).toHaveLength(USUAL_HOURS_MAX);
    expect(usual).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 18, 19]);
  });

  it("drops the habit once the person has been away three days", () => {
    const rhythm = usedAt([[4, 8], [5, 8], [6, 8], [7, 8]]);
    expect(usualHours(rhythm, NOW)).toBe(0);
    expect(usualHours(rhythm, NOW - DAY)).not.toBe(0);
  });

  it("writes only when it sees a new hour, and keeps two weeks", () => {
    const first = noteRequest([], NOW);
    expect(first).toEqual([{ day: TODAY, hours: 1 << 8 }]);
    expect(noteRequest(first!, NOW + 30 * MINUTE)).toBeNull();
    expect(noteRequest(first!, NOW + HOUR)).toEqual([{ day: TODAY, hours: (1 << 8) | (1 << 9) }]);
    const old = usedAt(everyDay(20, [9]));
    expect(old).toHaveLength(20);
    expect(noteRequest(old, NOW)!.map((entry) => entry.day)).toEqual(Array.from({ length: RHYTHM_DAYS }, (_, index) => TODAY - RHYTHM_DAYS + 1 + index));
  });

  it("finds the start of the next usual hour, wrapping past midnight", () => {
    const usual = (1 << 7) | (1 << 22);
    expect(nextUsualStart(usual, NOW)).toBe(MIDNIGHT + 22 * HOUR);
    expect(nextUsualStart(usual, MIDNIGHT + 22 * HOUR + MINUTE)).toBe(MIDNIGHT + DAY + 7 * HOUR);
    expect(nextUsualStart(0, NOW)).toBeNull();
  });

  it("reads back only a well-formed rhythm and hold", () => {
    expect(parseRhythm([{ day: TODAY, hours: 256 }, { day: -1, hours: 1 }, { day: TODAY - 1, hours: 2 ** 24 }, null, "x"])).toEqual([{ day: TODAY, hours: 256 }]);
    expect(parseRhythm(undefined)).toEqual([]);
    expect(parseWorkHold({ day: TODAY, usedMs: HOUR, since: NOW })).toEqual({ day: TODAY, usedMs: HOUR, since: NOW });
    expect(parseWorkHold({ day: TODAY, usedMs: -1, since: NOW })).toEqual(NO_WORK_HOLD);
    expect(parseWorkHold(undefined)).toEqual(NO_WORK_HOLD);
  });
});

describe("staying awake in the person's usual hours", () => {
  const mornings = usedAt(everyDay(3, [8, 9]));

  it("stays during a usual hour, even with no work and no answer, without counting it as work", () => {
    const hold = { day: TODAY, usedMs: WORK_DAY_MS, since: NOW - WORK_STRETCH_MS };
    expect(decide(IDLE, { rhythm: mornings, hold })).toEqual({ stay: true, reason: "usual", hold: { ...hold, since: null } });
    expect(decide(null, { rhythm: mornings, now: NOW + 90 * MINUTE })).toMatchObject({ stay: true, reason: "usual" });
  });

  it("stays through the last quarter hour before the person's usual hours start", () => {
    expect(decide(IDLE, { rhythm: mornings, now: NOW - 10 * MINUTE })).toMatchObject({ stay: true, reason: "usual" });
  });

  it("sleeps outside them and wakes a few minutes before they start", () => {
    const evening = MIDNIGHT + 21 * HOUR;
    expect(decide(IDLE, { rhythm: mornings, now: evening })).toMatchObject({
      stay: false, routineWakeAt: null, personWakeAt: MIDNIGHT + DAY + 8 * HOUR - PERSON_WAKE_EARLY_MS,
    });
  });

  it("goes back to counting work after the usual hours end", () => {
    const tenAm = MIDNIGHT + 10 * HOUR;
    const inUsual = decide(WORKING, { rhythm: mornings, now: tenAm - HOLD_STEP_MS });
    expect(inUsual).toMatchObject({ stay: true, reason: "usual" });
    expect(decide(WORKING, { rhythm: mornings, hold: inUsual.hold, now: tenAm })).toEqual({
      stay: true, reason: "work", hold: { day: TODAY, usedMs: HOLD_STEP_MS, since: tenAm },
    });
  });
});
