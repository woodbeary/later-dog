import { describe, expect, it } from "vitest";
import type { PlanProviderRow, PlanWindow } from "../plan-usage.ts";
import type { BatteryAccount } from "./account-battery.ts";
import { accountUsage, accountUsageText, type AccountUsageInput } from "./account-usage.ts";

const NOW = Date.parse("2026-11-06T07:00:00Z");
const HOUR = 3600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

const window = (used: number, resetsAt: string): PlanWindow => ({ available: true, usedPercent: used, remainingPercent: 100 - used, resetsAt });
const row = (id: string, fiveHour: number, weekly: number): PlanProviderRow => ({
  id, name: id, driver: "claude", plan: "Max", ok: true, error: null,
  fiveHour: window(fiveHour, at(2 * HOUR)), weekly: window(weekly, at(50 * HOUR)), extra: [], models: [],
});
const account = (instanceId: string, email: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: "Claude", email, enabled: true, eligible: true, signedIn: true, models: ["claude-opus-5-5"], ...extra,
});

const TONIGHT: AccountUsageInput[] = [
  { account: account("claude", "adam@txtclaw.com"), row: row("claude", 100, 60), rest: { until: at(3 * HOUR), since: at(0), kind: "session" },
    env: { name: "CLAUDE_CONFIG_DIR", value: "/data/.claude" } },
  { account: account("claude-jacob", "jacob@txtclaw.com"), row: row("claude-jacob", 10, 99), rest: undefined,
    env: { name: "CLAUDE_CONFIG_DIR", value: "/data/.laterdog/providers/claude-jacob" } },
  { account: account("claude-daniel", "daniel@txtclaw.com"), row: row("claude-daniel", 30, 21), rest: undefined,
    env: { name: "CLAUDE_CONFIG_DIR", value: "/data/.laterdog/providers/claude-daniel" } },
  { account: account("claude-anthony", "anthony@txtclaw.com", { signedIn: false }), row: undefined, rest: undefined },
];

describe("a dog's view of its plan accounts", () => {
  it("lists every account by how much is left and names the one with the most room, not the next in line", () => {
    const report = accountUsage(TONIGHT, "claude-jacob", NOW);
    expect(report.accounts.map((entry) => [entry.id, entry.status, entry.leftPercent])).toEqual([
      ["claude-daniel", "ready", 70],
      ["claude-jacob", "ready", 1],
      ["claude", "resting", 0],
      ["claude-anthony", "signed out", undefined],
    ]);
    expect(report.roomiest).toBe("claude-daniel");
    expect(report.accounts.find((entry) => entry.id === "claude-jacob")).toMatchObject({ current: true, weekly: { usedPercent: 99 } });
  });

  it("says it in a few lines, with what to set to run command-line work on the roomiest account", () => {
    const text = accountUsageText(accountUsage(TONIGHT, "claude-jacob", NOW), NOW, "America/Los_Angeles");
    expect(text).toContain("- Claude (daniel@txtclaw.com) [id: claude-daniel, Claude, most room]: 70% left. 5-hour 30% used, resets 1:00 AM; 7-day 21% used, resets Sun 1:00 AM.");
    expect(text).toContain("- Claude (jacob@txtclaw.com) [id: claude-jacob, Claude, this chat]: 1% left.");
    expect(text).toContain("- Claude (adam@txtclaw.com) [id: claude, Claude]: resting until 2:00 AM.");
    expect(text).toContain("CLAUDE_CONFIG_DIR=/data/.laterdog/providers/claude-daniel and without ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN set");
  });

  it("counts a window that has already reset as empty, and says so when nothing is ready", () => {
    const reset: AccountUsageInput = { account: account("claude", "adam@txtclaw.com"), row: { ...row("claude", 100, 60), fiveHour: window(100, at(-HOUR)) }, rest: undefined };
    expect(accountUsage([reset], undefined, NOW).accounts[0]).toMatchObject({ leftPercent: 40, fiveHour: { usedPercent: 0, resetsAt: null } });
    const none = accountUsage([TONIGHT[0]!, TONIGHT[3]!], undefined, NOW);
    expect(none.roomiest).toBeUndefined();
    expect(accountUsageText(none, NOW)).toContain("Every account is resting or off right now.");
    expect(accountUsageText(accountUsage([], undefined, NOW), NOW)).toContain("No plan accounts here");
  });
});
