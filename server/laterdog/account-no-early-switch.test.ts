import { describe, expect, it, vi } from "vitest";
import type { PlanProviderRow } from "../plan-usage.ts";
import { AccountBattery, type AccountBatteryConfig, type BatteryAccount } from "./account-battery.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const HOUR = 3600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

const claude = (instanceId: string): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true,
  models: ["claude-opus-5-5"], defaultModel: "claude-opus-5-5",
});
const ACCOUNTS = [claude("jacob"), claude("daniel"), claude("anthony")];
const CONFIG: AccountBatteryConfig = { enabled: true, auto: true, order: { claudeAgent: ["jacob", "daniel", "anthony"] } };
const ON_JACOB = { instanceId: "jacob", model: "claude-opus-5-5" };
const window = (usedPercent: number) => ({ available: true, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: at(48 * HOUR) });
const reading = (id: string, weekly: number): PlanProviderRow => ({
  id, name: id, driver: "claude", plan: "Max", ok: true, error: null, fiveHour: window(10), weekly: window(weekly), extra: [], models: [],
});
const READINGS: Record<string, PlanProviderRow> = { jacob: reading("jacob", 97), daniel: reading("daniel", 18), anthony: reading("anthony", 20) };

function battery() {
  return new AccountBattery({
    config: () => CONFIG, accounts: () => ACCOUNTS, now: () => NOW, usage: (id) => READINGS[id],
  });
}

describe("an account that is low but has not hit its limit", () => {
  it("keeps the dog on its own account with no notice", () => {
    const kept = battery();
    expect(kept.route(ON_JACOB, ACCOUNTS, "dog")).toBe(ON_JACOB);
    expect(kept.arrive("dog", ON_JACOB, "jacob", ACCOUNTS)).toBeUndefined();
  });

  it("moves the dog only once a turn actually hits the limit, to the account with the most room", () => {
    const moving = battery();
    moving.trackTurn("dog", { generation: "g1", instanceId: "jacob", rerun: vi.fn(async () => undefined) });
    const next = moving.nextAccount({ threadId: "dog", generation: "g1", stopReason: "usage_limit", ranOn: "jacob", selection: ON_JACOB, accounts: ACCOUNTS });
    expect(next?.to.instanceId).toBe("daniel");
  });
});
