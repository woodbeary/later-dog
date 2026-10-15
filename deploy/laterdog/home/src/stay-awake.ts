import { MIN_WAKE_DELAY_MS, WAKE_EARLY_MS, type HomeActivity } from "./activity.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const HOURS_IN_DAY = 24;

const HOLD_STEP_MINUTES = 10;
export const HOLD_SLEEP_AFTER = `${HOLD_STEP_MINUTES}m`;
export const HOLD_STEP_MS = HOLD_STEP_MINUTES * MINUTE_MS;
export const DUE_SOON_MS = 15 * MINUTE_MS;
export const WORK_STRETCH_MS = 6 * HOUR_MS;
export const WORK_DAY_MS = 12 * HOUR_MS;
export const RHYTHM_DAYS = 14;
export const USUAL_MIN_DAYS = 3;
export const USUAL_HOURS_MAX = 10;
export const RHYTHM_FRESH_MS = 3 * DAY_MS;
export const PERSON_WAKE_EARLY_MS = 3 * MINUTE_MS;

export interface RhythmDay {
  day: number;
  hours: number;
}

export type Rhythm = RhythmDay[];

export interface WorkHold {
  day: number;
  usedMs: number;
  since: number | null;
}

export const NO_WORK_HOLD: WorkHold = { day: 0, usedMs: 0, since: null };

export type HoldReason = "usual" | "work" | "due";
export type WorkCap = "stretch" | "day";

export type StayDecision =
  | { stay: true; reason: HoldReason; hold: WorkHold }
  | { stay: false; routineWakeAt: number | null; personWakeAt: number | null; hold: WorkHold; capped: WorkCap | null };

export interface StayInput {
  activity: HomeActivity | null;
  rhythm: Rhythm;
  hold: WorkHold;
  now: number;
}

function dayOf(at: number): number {
  return Math.floor(at / DAY_MS);
}

function hourOf(at: number): number {
  return Math.floor(at / HOUR_MS) % HOURS_IN_DAY;
}

function hourBit(at: number): number {
  return 1 << hourOf(at);
}

function lastSeenAt(entry: RhythmDay): number {
  return entry.day * DAY_MS + (31 - Math.clz32(entry.hours)) * HOUR_MS;
}

function fullHours(hours: unknown): hours is number {
  return Number.isInteger(hours) && (hours as number) > 0 && (hours as number) < 2 ** HOURS_IN_DAY;
}

export function parseRhythm(input: unknown): Rhythm {
  if (!Array.isArray(input)) return [];
  return input
    .filter((entry): entry is RhythmDay => Boolean(entry) && typeof entry === "object" && Number.isSafeInteger(entry.day) && entry.day >= 0 && fullHours(entry.hours))
    .map(({ day, hours }) => ({ day, hours }))
    .sort((a, b) => a.day - b.day)
    .slice(-RHYTHM_DAYS);
}

export function parseWorkHold(input: unknown): WorkHold {
  if (!input || typeof input !== "object") return NO_WORK_HOLD;
  const { day, usedMs, since } = input as Record<string, unknown>;
  if (!Number.isSafeInteger(day) || !Number.isSafeInteger(usedMs) || (usedMs as number) < 0) return NO_WORK_HOLD;
  return { day: day as number, usedMs: usedMs as number, since: Number.isSafeInteger(since) ? (since as number) : null };
}

export function noteRequest(rhythm: Rhythm, at: number): Rhythm | null {
  const day = dayOf(at);
  const today = rhythm.find((entry) => entry.day === day);
  if (today && today.hours & hourBit(at)) return null;
  const kept = rhythm.filter((entry) => entry.day !== day && entry.day > day - RHYTHM_DAYS);
  return [...kept, { day, hours: (today?.hours ?? 0) | hourBit(at) }].sort((a, b) => a.day - b.day);
}

export function usualHours(rhythm: Rhythm, now: number): number {
  const today = dayOf(now);
  const recent = rhythm.filter((entry) => entry.day > today - RHYTHM_DAYS && entry.day <= today);
  const last = recent.at(-1);
  if (!last || now - lastSeenAt(last) > RHYTHM_FRESH_MS) return 0;
  return Array.from({ length: HOURS_IN_DAY }, (_, hour) => ({ hour, days: recent.filter((entry) => entry.hours & (1 << hour)).length }))
    .filter((count) => count.days >= USUAL_MIN_DAYS)
    .sort((a, b) => b.days - a.days || a.hour - b.hour)
    .slice(0, USUAL_HOURS_MAX)
    .reduce((mask, count) => mask | (1 << count.hour), 0);
}

export function nextUsualStart(usual: number, now: number): number | null {
  if (!usual) return null;
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  for (let step = 1; step <= HOURS_IN_DAY; step += 1) {
    const at = hourStart + step * HOUR_MS;
    if (usual & hourBit(at)) return at;
  }
  return null;
}

function workReason(activity: HomeActivity | null, now: number): HoldReason | null {
  if (activity?.busy) return "work";
  if (activity?.nextAt != null && activity.nextAt - now <= DUE_SOON_MS) return "due";
  return null;
}

function workCap(hold: WorkHold, since: number, now: number): WorkCap | null {
  if (now - since >= WORK_STRETCH_MS) return "stretch";
  if (hold.usedMs >= WORK_DAY_MS) return "day";
  return null;
}

export function stayDecision({ activity, rhythm, hold: stored, now }: StayInput): StayDecision {
  const day = dayOf(now);
  const hold = stored.day === day ? stored : { day, usedMs: 0, since: stored.since };
  const usual = usualHours(rhythm, now);
  const nextUsual = nextUsualStart(usual, now);
  if (usual & hourBit(now) || (nextUsual !== null && nextUsual - now <= DUE_SOON_MS)) {
    return { stay: true, reason: "usual", hold: { ...hold, since: null } };
  }
  const reason = workReason(activity, now);
  const since = hold.since ?? now;
  const capped = reason ? workCap(hold, since, now) : null;
  if (reason && !capped) return { stay: true, reason, hold: { day, usedMs: hold.usedMs + HOLD_STEP_MS, since } };
  return {
    stay: false,
    routineWakeAt: activity?.nextAt ? Math.max(now + MIN_WAKE_DELAY_MS, activity.nextAt - WAKE_EARLY_MS) : null,
    personWakeAt: nextUsual === null ? null : Math.max(now + MIN_WAKE_DELAY_MS, nextUsual - PERSON_WAKE_EARLY_MS),
    hold: { ...hold, since: null },
    capped,
  };
}
