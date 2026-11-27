import { normalizeCronSchedule, nextCronRuns, type RoutineCronSchedule } from "./routine-schedule.ts";

export interface RoutineIntervalWindow {
  start: string;
  end: string;
}

export interface RoutineIntervalSchedule {
  type: "interval";
  everyMinutes: number;
  anchorAt: number;
  weekdays?: number[];
  window?: RoutineIntervalWindow;
  endsAt?: number;
}

export type RoutineIntervalScheduleInput = Omit<RoutineIntervalSchedule, "weekdays" | "window" | "endsAt"> & {
  weekdays?: number[] | null;
  window?: RoutineIntervalWindow | null;
  endsAt?: number | null;
};

export type RoutineSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | RoutineCronSchedule
  | RoutineIntervalSchedule;

export type RoutineScheduleInput =
  | Exclude<RoutineSchedule, RoutineIntervalSchedule>
  | RoutineIntervalScheduleInput;

export interface WallTime {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

export interface WallClock {
  wall(at: number): WallTime;
  instant(year: number, month: number, day: number, hour: number, minute: number): number;
}

export const localClock: WallClock = {
  wall(at) {
    const date = new Date(at);
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      weekday: date.getDay(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  },
  instant(year, month, day, hour, minute) {
    return new Date(year, month, day, hour, minute, 0, 0).getTime();
  },
};

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zoneClock(timeZone: string): WallClock {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
  });
  const wall = (at: number): WallTime => {
    const parts: Record<string, string> = {};
    for (const part of format.formatToParts(at)) parts[part.type] = part.value;
    return {
      year: Number(parts.year),
      month: Number(parts.month) - 1,
      day: Number(parts.day),
      weekday: WEEKDAYS[parts.weekday] ?? 0,
      hour: Number(parts.hour) % 24,
      minute: Number(parts.minute),
    };
  };
  const offset = (at: number) => {
    const shown = wall(at);
    return Date.UTC(shown.year, shown.month, shown.day, shown.hour, shown.minute) - Math.floor(at / 60_000) * 60_000;
  };
  return {
    wall,
    instant(year, month, day, hour, minute) {
      const guess = Date.UTC(year, month, day, hour, minute);
      const first = guess - offset(guess);
      const second = guess - offset(first);
      const wanted = new Date(guess);
      const shows = (candidate: number) => {
        const shown = wall(candidate);
        return shown.year === wanted.getUTCFullYear() && shown.month === wanted.getUTCMonth() && shown.day === wanted.getUTCDate() &&
          shown.hour === wanted.getUTCHours() && shown.minute === wanted.getUTCMinutes();
      };
      const matching = [first, second].filter(shows);
      return matching.length ? Math.min(...matching) : Math.max(first, second);
    },
  };
}

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const CATCH_UP_MS = 12 * 60 * 60_000;
export const MAX_DATE_MS = 8_640_000_000_000_000;
const LOCAL_DAY_MS = 24 * 60 * 60_000;
const INTERVAL_RESTRICTION_SEARCH_MS = 9 * LOCAL_DAY_MS;
const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class RoutineScheduleError extends Error {
  readonly status = 400;
}

export function cleanDays(days: unknown): number[] {
  if (!Array.isArray(days)) return ALL_DAYS;
  const out = [...new Set(days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return out.length ? out : ALL_DAYS;
}

function cleanIntervalWeekdays(value: unknown): number[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > ALL_DAYS.length) {
    throw new Error("Choose at least one valid interval day");
  }
  if (value.some((day) => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error("Interval days must be whole numbers from 0 to 6");
  }
  if (new Set(value).size !== value.length) throw new Error("Choose each interval day only once");
  const weekdays = [...value].sort((a, b) => a - b);
  return weekdays.length === ALL_DAYS.length ? undefined : weekdays;
}

function clockMinutes(value: string): number | null {
  const match = CLOCK_TIME.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function cleanIntervalWindow(value: unknown, everyMinutes: number): RoutineIntervalWindow | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Choose a valid interval time window");
  }
  const candidate = value as Partial<RoutineIntervalWindow>;
  const start = typeof candidate.start === "string" ? candidate.start : "";
  const end = typeof candidate.end === "string" ? candidate.end : "";
  const startMinutes = clockMinutes(start);
  const endMinutes = clockMinutes(end);
  if (startMinutes == null || endMinutes == null) {
    throw new Error("Interval window times must use HH:MM");
  }
  if (startMinutes >= endMinutes) {
    throw new Error("Interval window must start before it ends on the same day");
  }
  if (endMinutes - startMinutes < everyMinutes) {
    throw new Error("Interval window must be at least as long as the interval");
  }
  return { start, end };
}

function cleanIntervalEndsAt(value: unknown, anchorAt: number): number | undefined {
  if (value == null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < anchorAt ||
    value > MAX_DATE_MS
  ) {
    throw new Error("Choose a valid interval end time after its start");
  }
  return value;
}

function parseSchedule(schedule: RoutineScheduleInput, after: number): RoutineSchedule {
  if (schedule?.type === "cron") return normalizeCronSchedule(schedule, after);
  if (schedule?.type === "once") {
    const at = Number(schedule.at);
    if (!Number.isFinite(at)) throw new Error("Choose a valid date and time");
    return { type: "once", at };
  }
  if (schedule?.type === "daily") {
    const time = String(schedule.time ?? "");
    if (!CLOCK_TIME.test(time)) throw new Error("Time must use HH:MM");
    return { type: "daily", time, weekdays: cleanDays(schedule.weekdays) };
  }
  if (schedule?.type === "interval") {
    const { everyMinutes, anchorAt } = schedule;
    if (typeof everyMinutes !== "number" || !Number.isInteger(everyMinutes) || everyMinutes < 5 || everyMinutes > 1_440) {
      throw new Error("Interval must be a whole number from 5 to 1440 minutes");
    }
    if (
      typeof anchorAt !== "number" ||
      !Number.isSafeInteger(anchorAt) ||
      anchorAt < 0 ||
      anchorAt > MAX_DATE_MS
    ) {
      throw new Error("Choose a valid interval start time");
    }
    const weekdays = cleanIntervalWeekdays(schedule.weekdays);
    const window = cleanIntervalWindow(schedule.window, everyMinutes);
    const endsAt = cleanIntervalEndsAt(schedule.endsAt, anchorAt);
    return {
      type: "interval",
      everyMinutes,
      anchorAt,
      ...(weekdays ? { weekdays } : {}),
      ...(window ? { window } : {}),
      ...(endsAt === undefined ? {} : { endsAt }),
    };
  }
  throw new Error("Choose a supported schedule");
}

export function cleanSchedule(schedule: RoutineScheduleInput, after: number): RoutineSchedule {
  try { return parseSchedule(schedule, after); }
  catch (error) { throw new RoutineScheduleError((error as Error).message); }
}

export function loadSchedule(value: unknown, after: number): RoutineSchedule | null {
  try {
    return cleanSchedule(value as RoutineScheduleInput, after);
  } catch {
    return null;
  }
}

export function intervalHasRestrictions(
  schedule: Pick<RoutineIntervalSchedule, "weekdays" | "window" | "endsAt">,
): boolean {
  return schedule.weekdays !== undefined || schedule.window !== undefined || schedule.endsAt !== undefined;
}

export function intervalAllowsOccurrence(schedule: RoutineIntervalSchedule, at: number, clock: WallClock = localClock): boolean {
  if (schedule.endsAt !== undefined && at > schedule.endsAt) return false;
  const wall = clock.wall(at);
  if (schedule.weekdays && !schedule.weekdays.includes(wall.weekday)) return false;
  if (schedule.window) {
    const minute = wall.hour * 60 + wall.minute;
    const start = clockMinutes(schedule.window.start)!;
    const end = clockMinutes(schedule.window.end)!;
    if (minute < start || minute >= end) return false;
  }
  return true;
}

export function isSameLocalDay(left: number, right: number, clock: WallClock = localClock): boolean {
  const a = clock.wall(left);
  const b = clock.wall(right);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function nextAlignedInterval(schedule: RoutineIntervalSchedule, after: number): number | null {
  if (schedule.anchorAt > after) return schedule.anchorAt;
  const intervalMs = schedule.everyMinutes * 60_000;
  const intervalsElapsed = Math.floor((after - schedule.anchorAt) / intervalMs);
  const candidate = schedule.anchorAt + (intervalsElapsed + 1) * intervalMs;
  return Number.isSafeInteger(candidate) && candidate <= MAX_DATE_MS ? candidate : null;
}

export function nextOccurrence(schedule: RoutineSchedule, after: number, clock: WallClock = localClock): number | null {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.type === "cron") return nextCronRuns(schedule, after, 1)[0] ?? null;
  if (schedule.type === "interval") {
    const intervalMs = schedule.everyMinutes * 60_000;
    let candidate = nextAlignedInterval(schedule, after);
    if (!intervalHasRestrictions(schedule)) return candidate;
    const maxCandidates = Math.ceil(INTERVAL_RESTRICTION_SEARCH_MS / intervalMs) + 2;
    for (let checked = 0; candidate !== null && checked < maxCandidates; checked++) {
      if (schedule.endsAt !== undefined && candidate > schedule.endsAt) return null;
      if (intervalAllowsOccurrence(schedule, candidate, clock)) return candidate;
      const next = candidate + intervalMs;
      candidate = Number.isSafeInteger(next) && next <= MAX_DATE_MS ? next : null;
    }
    return null;
  }
  const [hour, minute] = schedule.time.split(":").map(Number);
  const weekdays = new Set(cleanDays(schedule.weekdays));
  const start = clock.wall(after);
  for (let offset = 0; offset <= 8; offset++) {
    const at = clock.instant(start.year, start.month, start.day + offset, hour, minute);
    if (at > after && weekdays.has(clock.wall(at).weekday)) return at;
  }
  return null;
}

export function latestIntervalOccurrence(
  schedule: RoutineIntervalSchedule,
  at: number,
  clock: WallClock = localClock,
): number | null {
  const intervalMs = schedule.everyMinutes * 60_000;
  const ceiling = Math.min(at, schedule.endsAt ?? at);
  if (schedule.anchorAt > ceiling) return null;
  let candidate = schedule.anchorAt + Math.floor((ceiling - schedule.anchorAt) / intervalMs) * intervalMs;
  if (!intervalHasRestrictions(schedule)) return candidate;
  const maxCandidates = Math.ceil(INTERVAL_RESTRICTION_SEARCH_MS / intervalMs) + 2;
  for (let checked = 0; checked < maxCandidates; checked++) {
    if (intervalAllowsOccurrence(schedule, candidate, clock)) return candidate;
    const previous = candidate - intervalMs;
    if (!Number.isSafeInteger(previous) || previous < schedule.anchorAt) return null;
    candidate = previous;
  }
  return null;
}

export function mergeScheduleUpdate(
  current: RoutineSchedule,
  incoming: RoutineScheduleInput,
): RoutineScheduleInput {
  if (current.type !== "interval" || incoming.type !== "interval") return incoming;
  const merged: RoutineIntervalScheduleInput = { ...incoming };
  if (!Object.hasOwn(incoming, "weekdays") && current.weekdays) {
    merged.weekdays = [...current.weekdays];
  }
  if (!Object.hasOwn(incoming, "window") && current.window) {
    merged.window = { ...current.window };
  }
  if (!Object.hasOwn(incoming, "endsAt") && current.endsAt !== undefined) {
    merged.endsAt = current.endsAt;
  }
  return merged;
}

export interface DueOccurrence {
  scheduledFor: number;
  nextRunAt: number | null;
  missed: boolean;
}

export function dueOccurrence(schedule: RoutineSchedule, pendingAt: number, now: number, clock: WallClock = localClock): DueOccurrence {
  const late = now - pendingAt;
  const scheduledFor = schedule.type === "interval" && late <= CATCH_UP_MS
    ? latestIntervalOccurrence(schedule, now, clock) ?? pendingAt
    : pendingAt;
  return {
    scheduledFor,
    nextRunAt: schedule.type === "once" ? null : nextOccurrence(schedule, Math.max(now, scheduledFor), clock),
    missed: late > CATCH_UP_MS,
  };
}
