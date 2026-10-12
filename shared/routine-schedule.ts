import { Cron } from "croner";

export interface RoutineCronSchedule {
  type: "cron";
  expression: string;
  timeZone: string;
}

const MAX_EXPRESSION_LENGTH = 256;
const MAX_PREVIEW_RUNS = 1000;

function cronCalculator(value: unknown): { schedule: RoutineCronSchedule; cron: Cron } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a valid cron schedule");
  const input = value as Partial<RoutineCronSchedule>;
  if (input.type !== "cron" || typeof input.expression !== "string") throw new Error("Choose a valid cron schedule");
  if (Object.keys(input).some(key => !["type", "expression", "timeZone"].includes(key))) {
    throw new Error("Cron schedules accept only type, expression and timeZone; start/end dates and other restrictions are not supported");
  }
  const expression = input.expression.trim().replace(/\s+/g, " ");
  if (expression.length > MAX_EXPRESSION_LENGTH || expression.split(" ").length !== 5 || expression.includes("@")) {
    throw new Error("Cron must have five fields: minute hour day-of-month month weekday (no seconds, year, or macros)");
  }
  const timeZone = typeof input.timeZone === "string" ? input.timeZone.trim() : "";
  if (timeZone.length > 128 || !(timeZone === "UTC" || /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/.test(timeZone))) {
    throw new Error("Choose an IANA timezone such as America/New_York, Asia/Kolkata, or UTC");
  }
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(0); }
  catch { throw new Error("Choose a valid IANA timezone such as America/New_York, Asia/Kolkata, or UTC"); }
  try {
    const cron = new Cron(expression, { timezone: timeZone, mode: "5-part", paused: true });
    return { schedule: { type: "cron", expression, timeZone }, cron };
  } catch (error) {
    throw new Error(`Invalid cron expression: ${(error as Error).message}`);
  }
}

function calculationDate(after: number): Date {
  const date = new Date(after);
  if (!Number.isFinite(after) || !Number.isFinite(date.getTime())) throw new Error("Choose a valid cron preview date");
  return date;
}

function futureRuns(cron: Cron, after: number, count: number): number[] {
  const from = calculationDate(after);
  const maximum = count + 1440;
  let requested = count;
  while (true) {
    const candidates = cron.nextRuns(requested, from);
    const runs: number[] = [];
    for (const date of candidates) {
      const at = date.getTime();
      if (!Number.isFinite(at)) throw new Error("The cron schedule produced an invalid date");
      if (at > (runs.at(-1) ?? after)) runs.push(at);
      if (runs.length === count) return runs;
    }
    if (candidates.length < requested || requested === maximum) return runs;
    requested = Math.min(maximum, requested * 2);
  }
}

export function normalizeCronSchedule(value: unknown, after = Date.now()): RoutineCronSchedule {
  const { schedule, cron } = cronCalculator(value);
  if (!futureRuns(cron, after, 1).length) throw new Error("This cron expression has no future runs. Choose dates that exist.");
  return schedule;
}

export function nextCronRuns(schedule: RoutineCronSchedule, after: number, count: number): number[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_PREVIEW_RUNS) throw new Error("Choose between 1 and 1000 cron preview runs");
  const { cron } = cronCalculator(schedule);
  return futureRuns(cron, after, count);
}
