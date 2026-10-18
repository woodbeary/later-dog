import { describe, expect, it } from "vitest";

import { routineScheduleLabel, withScheduleLabel } from "./routine-schedule-label.ts";

describe("the schedule label the server sends with each routine", () => {
  it("describes cron rules in words with their zone", () => {
    expect(routineScheduleLabel({ type: "cron", expression: "0 9 * * *", timeZone: "Asia/Kolkata" }, "UTC")).toBe("Every day at 09:00 · Asia/Kolkata");
    expect(routineScheduleLabel({ type: "cron", expression: "30 8 * * 1-5", timeZone: "America/Los_Angeles" }, "UTC")).toBe("Every weekday at 08:30 · America/Los_Angeles");
    expect(routineScheduleLabel({ type: "cron", expression: "*/7 * * * *", timeZone: "UTC" }, "UTC")).toBe("Cron */7 * * * * · UTC");
  });

  it("keeps daily times as wall-clock times and dates in the home's zone", () => {
    expect(routineScheduleLabel({ type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, "Asia/Kolkata")).toBe("Every day at 9:00 AM");
    expect(routineScheduleLabel({ type: "daily", time: "18:15", weekdays: [5] }, "UTC")).toBe("Weekly on Friday at 6:15 PM");
    const at = Date.UTC(2026, 9, 18, 3, 30);
    expect(routineScheduleLabel({ type: "once", at }, "Asia/Kolkata")).toBe("Once on October 18 at 9:00 AM");
    expect(routineScheduleLabel({ type: "interval", everyMinutes: 90 }, "UTC")).toBe("Every 1 hour 30 minutes");
  });

  it("adds the label without changing the routine", () => {
    const routine = { id: "r1", name: "Digest", schedule: { type: "cron" as const, expression: "0 9 * * *", timeZone: "Asia/Kolkata" } };
    expect(withScheduleLabel(routine, "UTC")).toEqual({ ...routine, scheduleLabel: "Every day at 09:00 · Asia/Kolkata" });
    expect(routine).not.toHaveProperty("scheduleLabel");
  });
});
