import { describe, expect, it } from "vitest";
import type { PlanProviderRow } from "../plan-usage.ts";
import { AccountBattery, type AccountBatteryConfig, type BatteryAccount } from "./account-battery.ts";
import { accountUsage, accountUsageText, withRestingUntil } from "./account-usage.ts";
import { claudeUsageLimit } from "./usage-limit.ts";

const NOW = Date.parse("2026-11-14T18:49:00Z");
const SESSION_RESET = "2026-11-14T23:49:00.000Z";
const WEEK_RESET = "2026-11-16T16:59:30.000Z";
const MONDAY_NINE = "2026-11-16T17:00:00.000Z";
const JACOB_WEEK_RESET = "2026-11-14T22:00:00.000Z";
const FABLE = "claude-fable-5-1";
const OPUS = "claude-opus-5-5";

const claude = (instanceId: string): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, email: `${instanceId}@example.test`, enabled: true, eligible: true, signedIn: true,
  models: [FABLE, OPUS], defaultModel: FABLE,
});
const ACCOUNTS = [claude("jacob"), claude("daniel"), claude("anthony")];
const CONFIG: AccountBatteryConfig = { enabled: true, auto: true, order: { claudeAgent: ["jacob", "daniel", "anthony"] } };

const window = (usedPercent: number, resetsAt: string) => ({ available: true, usedPercent, remainingPercent: 100 - usedPercent, resetsAt });
const reading = (id: string, fiveHour: number, weekly: number, weekReset = WEEK_RESET): PlanProviderRow => ({
  id, name: id, driver: "claude", plan: "max", ok: true, error: null,
  fiveHour: window(fiveHour, SESSION_RESET), weekly: window(weekly, weekReset), extra: [], models: [],
});
const READINGS: Record<string, PlanProviderRow> = {
  jacob: reading("jacob", 0, 100, JACOB_WEEK_RESET),
  daniel: reading("daniel", 0, 69),
  anthony: reading("anthony", 12, 40),
};

const engineRefusal = (info: Record<string, unknown> | undefined, text: string) => ({
  type: "assistant",
  message: { model: "<synthetic>", content: [{ type: "text", text }] },
  error: "rate_limit",
  is_api_error_message: true,
  ...(info ? { api_error: "usage_limit_reached", api_error_params: { rate_limit_info: info } } : {}),
});

function home() {
  const battery = new AccountBattery({
    config: () => CONFIG, accounts: () => ACCOUNTS, now: () => NOW, usage: (id) => READINGS[id], usageAt: () => NOW - 60_000,
  });
  const restOf = (instanceId: string) => battery.restOf(ACCOUNTS.find((account) => account.instanceId === instanceId)!, ACCOUNTS);
  return { battery, restOf };
}

describe("daniel's case: one model's own weekly allowance is used up while the account has room", () => {
  it.each([
    ["the frame the engine sends", engineRefusal({ status: "rejected", rateLimitType: "seven_day_overage_included", resetsAt: Date.parse(MONDAY_NINE) / 1000 }, "You've reached your Fable limit.")],
    ["the words alone", engineRefusal(undefined, "You've reached your Fable limit. Switch to another model to continue.")],
  ])("from %s leaves daniel ready with 31 percent left and stops only Fable on it until Monday 9:00", (_source, frame) => {
    const text = frame.message.content[0]!.text;
    const quota = claudeUsageLimit(frame, text, NOW, { resetsAt: MONDAY_NINE });
    expect(quota).toMatchObject({ resetsAt: MONDAY_NINE });
    const { battery, restOf } = home();
    battery.markExhausted("daniel", quota!);

    expect(battery.status(ACCOUNTS).resting).not.toHaveProperty("daniel");
    expect(battery.status(ACCOUNTS).resting.jacob?.until).toBe(JACOB_WEEK_RESET);
    expect(battery.route({ instanceId: "daniel", model: OPUS }, ACCOUNTS, "opus-dog")).toEqual({ instanceId: "daniel", model: OPUS });
    expect(battery.route({ instanceId: "daniel", model: FABLE }, ACCOUNTS, "fable-dog")).toEqual({ instanceId: "anthony", model: FABLE });
    expect(battery.restOf(claude("daniel"), ACCOUNTS, FABLE)?.until).toBe(MONDAY_NINE);

    const report = withRestingUntil({ fetchedAt: new Date(NOW).toISOString(), providers: Object.values(READINGS) }, restOf);
    expect(report.providers.find((row) => row.id === "daniel")).not.toHaveProperty("restingUntil");
    expect(report.providers.find((row) => row.id === "jacob")?.restingUntil).toBe(JACOB_WEEK_RESET);

    const usage = accountUsage(ACCOUNTS.map((account) => ({ account, row: READINGS[account.instanceId], rest: restOf(account.instanceId) })), "daniel", NOW);
    expect(usage.accounts.find((row) => row.id === "daniel")).toMatchObject({ status: "ready", leftPercent: 31 });
    expect(accountUsageText(usage, NOW, "America/Los_Angeles")).toContain("- daniel (daniel@example.test) [id: daniel, Claude, this chat]: 31% left.");
  });
});
