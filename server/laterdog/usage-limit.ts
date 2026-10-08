// What Claude Code and Codex say when a subscription account reaches its
// usage limit, read into the two facts the token battery needs
// (account-battery.ts): when the limit resets, and which limit it was. Pure:
// the drivers hand it frames.
//
// Claude Code 2.1.x reports a reached limit as an api-error frame. Its text
// is the sentence a person reads, e.g.
//   You've hit your session limit · resets 3pm (America/Los_Angeles)
//   You've hit your weekly limit · resets Oct 9, 5pm (America/Los_Angeles)
// (Opus and Sonnet limits read alike; " · progress saved" may follow), and
// its fields say the same in structure: the error field is "rate_limit",
// `api_error: "usage_limit_reached"` and `api_error_params.rate_limit_info`
// `{ status: "rejected", rateLimitType, resetsAt }`. Separate
// `rate_limit_event` frames carry the same `rate_limit_info` on their own.
// Older builds wrote "Claude AI usage limit reached|<epoch seconds>".

export interface UsageLimit {
  /** ISO time the limit resets, when the frame or its words say. */
  resetsAt?: string;
  /** Which limit: session, weekly, daily, monthly, opus, sonnet, usage, or
   * the CLI's own rateLimitType when it names another. */
  kind?: string;
}

type Frame = Record<string, unknown>;

/** The wording of a reached subscription limit. Kept in step with the quota
 * class in server/drivers/retry.ts. */
const LIMIT_WORDS = /\b(?:hit|reached) your (?:(?:5-hour|session|weekly|daily|monthly|opus|sonnet|usage) )?limit\b|\b(?:usage|5-hour|session|weekly|daily|monthly) limit reached\b/i;
const LIMIT_KIND_WORDS = /\b(?:hit|reached) your (5-hour|session|weekly|daily|monthly|opus|sonnet|usage) limit\b/i;
/** Claude's rateLimitType names, as the limit a person reads. */
const RATE_LIMIT_KINDS: Record<string, string> = {
  five_hour: "session",
  seven_day: "weekly",
  seven_day_opus: "opus",
  seven_day_sonnet: "sonnet",
};
/** A reset further out than this is not believed. */
const MAX_AHEAD_MS = 40 * 24 * 60 * 60 * 1000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function record(value: unknown): Frame | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Frame : undefined;
}

/** The `rate_limit_info` a frame carries, wherever this CLI build put it. */
function rateLimitInfo(frame: Frame): Frame | undefined {
  const message = record(frame.message);
  const params = record(frame.api_error_params) ?? record(message?.api_error_params);
  return record(params?.rate_limit_info) ?? record(frame.rate_limit_info) ?? record(message?.rate_limit_info);
}

/** An epoch (seconds or milliseconds) or ISO time, as an ISO time that is
 * plausibly a reset: not in the past, and within MAX_AHEAD_MS. */
export function resetInstant(value: unknown, now: number): string | undefined {
  let at: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) at = value;
  else if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    at = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : Date.parse(text);
  }
  if (at === undefined || !Number.isFinite(at)) return undefined;
  // Ten digits of seconds run to the year 2286; anything larger is ms.
  if (Math.abs(at) < 1e11) at *= 1000;
  if (at < now - 60_000 || at > now + MAX_AHEAD_MS) return undefined;
  return new Date(Math.round(at)).toISOString();
}

function kindOf(type: unknown): string | undefined {
  if (typeof type !== "string" || !/^[a-z][a-z0-9_]{0,39}$/i.test(type)) return undefined;
  return RATE_LIMIT_KINDS[type] ?? type.toLowerCase();
}

/** The limit a `rate_limit_info` reports as reached, or null when it is only
 * a warning (status allowed / allowed_warning). */
export function rejectedRateLimit(info: unknown, now: number = Date.now()): UsageLimit | null {
  const fields = record(info);
  if (!fields || fields.status !== "rejected") return null;
  const resetsAt = resetInstant(fields.resetsAt, now);
  const kind = kindOf(fields.rateLimitType);
  return { ...(resetsAt ? { resetsAt } : {}), ...(kind ? { kind } : {}) };
}

/** The time zone a reset is said in, or this machine's own when it names
 * none or one Intl does not know. */
function zoneOrLocal(zone: string | undefined): string {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone) return local;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return local;
  }
}

/** The wall-clock fields of an instant in a zone. */
function wallClock(zone: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(at));
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: field("year"), month: field("month") - 1, day: field("day"), hour: field("hour") % 24, minute: field("minute"), second: field("second") };
}

/** The instant a zone's wall clock reads this date and time (the earlier of
 * two, across a daylight-saving change). */
function zonedInstant(zone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const asUtc = Date.UTC(year, month, day, hour, minute);
  const offset = (at: number) => {
    const wall = wallClock(zone, at);
    return Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(at / 1000) * 1000;
  };
  const first = asUtc - offset(asUtc);
  return asUtc - offset(first);
}

const RESET_WORDS = /(?:\bresets?\s+(?:at\s+|on\s+)?|\btry again (?:at|on)\s+)(?:(?<month>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?:\d{4},?\s+)?(?:at\s+)?)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)\b(?:\s*\((?<zone>[^)\n]{1,64})\))?/i;

/** "resets 3pm (America/Los_Angeles)", "resets Oct 9, 5pm (…)" or Codex's
 * "try again at 3:05 PM" as an ISO time: the next such wall-clock time in that
 * zone (this machine's when the words name none), or that date's. */
export function parseResetWords(text: string, now: number = Date.now()): string | undefined {
  const match = RESET_WORDS.exec(text);
  if (!match?.groups) return undefined;
  const { month, day, hour, minute, meridiem, zone } = match.groups;
  const clock = Number(hour);
  const minutes = minute ? Number(minute) : 0;
  if (clock < 1 || clock > 12 || minutes > 59) return undefined;
  const hours = (clock % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0);
  const tz = zoneOrLocal(zone?.trim());
  const today = wallClock(tz, now);
  let at: number;
  if (month) {
    const monthIndex = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
    const date = Number(day);
    if (monthIndex < 0 || date < 1 || date > 31) return undefined;
    at = zonedInstant(tz, today.year, monthIndex, date, hours, minutes);
    // "Jan 2" read on Dec 30 is next year's.
    if (at < now - 24 * 60 * 60 * 1000) at = zonedInstant(tz, today.year + 1, monthIndex, date, hours, minutes);
  } else {
    at = zonedInstant(tz, today.year, today.month, today.day, hours, minutes);
    if (at <= now) at = zonedInstant(tz, today.year, today.month, today.day + 1, hours, minutes);
  }
  return resetInstant(at, now);
}

/** Which limit the words name, if they name one. */
export function limitKindFromWords(text: string): string | undefined {
  const named = LIMIT_KIND_WORDS.exec(text)?.[1]?.toLowerCase();
  return named === "5-hour" ? "session" : named;
}

/** Whether a frame is Claude Code reporting a reached usage limit, and what
 * it says about the limit. Like claudeAuthFailure, the frame must be one the
 * CLI itself flagged as an API error: a model reply that merely talks about
 * limits never is. `event` is a rejected `rate_limit_event` seen earlier in
 * the same turn, used for what the error frame leaves out. */
export function claudeUsageLimit(
  frame: { error?: unknown; is_api_error_message?: unknown; [key: string]: unknown },
  text: string,
  now: number = Date.now(),
  event?: UsageLimit,
): UsageLimit | null {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return null;
  const message = record(frame.message);
  const apiError = frame.api_error ?? message?.api_error;
  const info = rateLimitInfo(frame);
  const structured = apiError === "usage_limit_reached" || (frame.error === "rate_limit" && record(info)?.status === "rejected");
  if (!structured && !LIMIT_WORDS.test(text)) return null;
  const reported = rejectedRateLimit(info ? { ...info, status: "rejected" } : undefined, now);
  const legacy = /usage limit reached\|(\d{9,13})/i.exec(text)?.[1];
  const resetsAt = reported?.resetsAt ?? (legacy ? resetInstant(Number(legacy), now) : undefined) ??
    parseResetWords(text, now) ?? event?.resetsAt;
  const kind = reported?.kind ?? limitKindFromWords(text) ?? event?.kind;
  return { ...(resetsAt ? { resetsAt } : {}), ...(kind ? { kind } : {}) };
}

/** Codex's account windows as its app-server last reported them
 * (`account/rateLimits/updated`, codex-cli 0.154): primary is the 5-hour
 * window, secondary the weekly one; resetsAt is epoch seconds. */
export interface CodexRateLimitWindow { usedPercent?: number | null; windowDurationMins?: number | null; resetsAt?: number | null }
export interface CodexRateLimits { primary?: CodexRateLimitWindow | null; secondary?: CodexRateLimitWindow | null }

/** Codex's sentence for a reached limit ("You've hit your usage limit. …"),
 * and the ChatGPT plan's own code for one. */
const CODEX_LIMIT_WORDS = /\byou'?ve hit your usage limit\b|usage_limit_(?:reached|exceeded)\b/i;
/** Older builds: "try again in 2 days 3 hours 5 minutes". */
const RETRY_IN = /\btry again in\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?)[\s,]*(?:and\s+)?)+)/i;

function retryInWords(text: string, now: number): string | undefined {
  const words = RETRY_IN.exec(text)?.[1];
  if (!words) return undefined;
  let ms = 0;
  for (const [, count, unit] of words.matchAll(/(\d+)\s*(d|h|m)/gi)) {
    ms += Number(count) * (unit!.toLowerCase() === "d" ? 86_400_000 : unit!.toLowerCase() === "h" ? 3_600_000 : 60_000);
  }
  return ms > 0 ? resetInstant(now + ms, now) : undefined;
}

function codexWindowKind(minutes: number | null | undefined): string | undefined {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return undefined;
  return minutes <= 6 * 60 ? "session" : minutes >= 6 * 24 * 60 ? "weekly" : undefined;
}

/** Whether a Codex turn error (TurnError: message, codexErrorInfo) is its
 * ChatGPT account reaching its usage limit, and when that limit resets: from
 * the account's full windows when it reported them (the latest to reset, since
 * a full weekly window outlasts the 5-hour one), else from Codex's sentence.
 * A model reply never arrives as a turn error, so it cannot land here. */
export function codexUsageLimit(error: { message?: unknown; codexErrorInfo?: unknown }, windows?: CodexRateLimits, now: number = Date.now()): UsageLimit | null {
  const text = typeof error.message === "string" ? error.message : "";
  if (error.codexErrorInfo !== "usageLimitExceeded" && !CODEX_LIMIT_WORDS.test(text)) return null;
  const binding = [windows?.primary, windows?.secondary]
    .flatMap((window) => {
      if (!window || (window.usedPercent ?? 0) < 99.5) return [];
      const resetsAt = resetInstant(window.resetsAt, now);
      return resetsAt ? [{ resetsAt, kind: codexWindowKind(window.windowDurationMins) }] : [];
    })
    .sort((a, b) => a.resetsAt.localeCompare(b.resetsAt))
    .at(-1);
  const resetsAt = binding?.resetsAt ?? parseResetWords(text, now) ?? retryInWords(text, now);
  const kind = binding?.kind;
  return { ...(resetsAt ? { resetsAt } : {}), ...(kind ? { kind } : {}) };
}
