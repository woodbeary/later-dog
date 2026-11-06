import { afterEach, describe, expect, it } from "vitest";
import { clearPlanUsageCache, latestPlanRow, loadPlanUsage, type PlanAccount } from "../plan-usage.ts";
import { claudeLiveReading, liveReading, noteLiveReading } from "./plan-readings.ts";

const NOW = Date.parse("2026-11-06T07:00:00Z");
const RATE_LIMIT_INFO = {
  status: "allowed", resetsAt: 1793961000, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.3, resetsAt: 1793961000, status: "allowed" },
    seven_day: { utilization: 0.21, resetsAt: 1794243600, status: "allowed" },
  },
};

afterEach(() => clearPlanUsageCache());

describe("usage read from a turn's own rate limit events", () => {
  it("reads the 5-hour and 7-day windows the engine reports with every turn", () => {
    expect(claudeLiveReading(RATE_LIMIT_INFO, NOW)).toEqual({
      at: NOW,
      fiveHour: { usedPercent: 30, resetsAt: new Date(1793961000 * 1000).toISOString() },
      weekly: { usedPercent: 21, resetsAt: new Date(1794243600 * 1000).toISOString() },
    });
    expect(claudeLiveReading({ status: "allowed" }, NOW)).toBeNull();
    expect(claudeLiveReading(undefined, NOW)).toBeNull();
  });

  it("lets the battery see an account it has only heard from in a turn, and the newest of a fetched and a live reading", async () => {
    expect(latestPlanRow("claude-daniel")).toBeUndefined();
    noteLiveReading("claude-daniel", claudeLiveReading(RATE_LIMIT_INFO, NOW));
    expect(latestPlanRow("claude-daniel")).toMatchObject({ ok: true, fiveHour: { usedPercent: 30, remainingPercent: 70 }, weekly: { usedPercent: 21 } });

    const account: PlanAccount = { id: "claude-daniel", name: "daniel", driver: "claude", environment: {} };
    const body = { five_hour: { utilization: 50, resets_at: "2026-11-06T09:00:00Z" }, seven_day: { utilization: 40, resets_at: "2026-11-09T09:00:00Z" } };
    const fetchOnce = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const credentials = { read: () => ({ token: "fixture", accountId: null, expired: false }) };
    await loadPlanUsage({ accounts: [account], refresh: true, now: NOW + 1000, fetch: fetchOnce, credentials });
    expect(latestPlanRow("claude-daniel")).toMatchObject({ fiveHour: { usedPercent: 50 }, weekly: { usedPercent: 40 } });

    noteLiveReading("claude-daniel", claudeLiveReading({ unifiedWindows: { five_hour: { utilization: 0.62, resetsAt: 1793961000 } } }, NOW + 2000));
    expect(latestPlanRow("claude-daniel")).toMatchObject({ fiveHour: { usedPercent: 62 }, weekly: { usedPercent: 21 } });
    noteLiveReading("claude-daniel", claudeLiveReading(RATE_LIMIT_INFO, NOW));
    expect(liveReading("claude-daniel")?.fiveHour?.usedPercent).toBe(62);
  });
});
