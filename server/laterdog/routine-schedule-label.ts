import type { Routine } from "../routines.ts";
import type { RoutineRequestSchedule } from "../../shared/routine-request.ts";
import { cronScheduleLabel } from "../../shared/cron-label.ts";

export type LabelledSchedule = RoutineRequestSchedule | Routine["schedule"];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function clockAt(at: number, timeZone: string): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

function wallClock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map((part) => Number.parseInt(part, 10) || 0);
  return clockAt(Date.UTC(2000, 0, 1, h, m), "UTC");
}

export function routineScheduleLabel(schedule: LabelledSchedule, timeZone: string): string {
  if (schedule.type === "cron") return cronScheduleLabel(schedule);
  if (schedule.type === "once") {
    const date = new Date(schedule.at).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone });
    return `Once on ${date} at ${clockAt(schedule.at, timeZone)}`;
  }
  if (schedule.type === "interval") {
    const minutes = schedule.everyMinutes;
    if (minutes < 60) return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
    if (minutes === 60) return "Every hour";
    if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
    return `Every ${Math.floor(minutes / 60)} hour${Math.floor(minutes / 60) === 1 ? "" : "s"} ${minutes % 60} minutes`;
  }
  const days = schedule.weekdays;
  const at = ` at ${wallClock(schedule.time)}`;
  if (days.length === 7) return `Every day${at}`;
  if (days.join(",") === "1,2,3,4,5") return `Every weekday${at}`;
  if (days.length === 1) return `Weekly on ${DAY_NAMES[days[0]!]}${at}`;
  return `${days.map((day) => DAY_NAMES[day]).join(", ")}${at}`;
}

export function withScheduleLabel<T extends { schedule: LabelledSchedule }>(routine: T, timeZone: string): T & { scheduleLabel: string } {
  return { ...routine, scheduleLabel: routineScheduleLabel(routine.schedule, timeZone) };
}
