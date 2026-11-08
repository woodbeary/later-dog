import { describe, expect, it, vi } from "vitest";
import type { PlanProviderRow } from "../plan-usage.ts";
import { AccountBattery, usedUpRest, type AccountBatteryConfig, type BatteryAccount } from "./account-battery.ts";
import { accountUsage, withRestingUntil } from "./account-usage.ts";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const HOUR = 3600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

const claude = (instanceId: string): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true,
  models: ["claude-opus-5"], defaultModel: "claude-opus-5",
});
const ACCOUNTS = [claude("home"), claude("adam"), claude("beth"), claude("cara")];
const ON: AccountBatteryConfig = { enabled: true, order: { claudeAgent: ["home", "adam", "beth", "cara"] } };
const ON_ADAM = { instanceId: "adam", model: "claude-opus-5" };

const window = (usedPercent: number, resetsAt: string) => ({ available: true, usedPercent, remainingPercent: 100 - usedPercent, resetsAt });
const reading = (id: string, fiveHour: number, weekly: number): PlanProviderRow => ({
  id, name: id, driver: "claude", plan: "Max", ok: true, error: null,
  fiveHour: window(fiveHour, at(2 * HOUR)), weekly: window(weekly, at(72 * HOUR)), extra: [], models: [],
});

function setup(adam: PlanProviderRow, pinned = false) {
  let now = NOW;
  const readings: Record<string, PlanProviderRow> = {
    home: reading("home", 70, 20), adam, beth: reading("beth", 50, 10), cara: reading("cara", 10, 5),
  };
  const battery = new AccountBattery({
    config: () => ON, accounts: () => ACCOUNTS, now: () => now, usage: (id) => readings[id],
    running: () => ({}), defaultAccount: () => "home", ownThread: () => true, pinnedThread: (threadId) => pinned && threadId === "pinned-dog",
  });
  return { battery, advance: (ms: number) => { now += ms; } };
}

describe("an account at 100% of a usage window", () => {
  it("counts as used up until that window resets, with no limit event recorded", () => {
    expect(usedUpRest(reading("adam", 100, 40), NOW)).toEqual({ until: at(2 * HOUR), kind: "session", since: at(0) });
    expect(usedUpRest(reading("adam", 30, 100), NOW)).toEqual({ until: at(72 * HOUR), kind: "weekly", since: at(0) });
    expect(usedUpRest(reading("adam", 100, 100), NOW)?.until).toBe(at(72 * HOUR));
    expect(usedUpRest(reading("adam", 99, 40), NOW)).toBeUndefined();
    expect(usedUpRest(reading("adam", 100, 40), NOW + 2 * HOUR)).toBeUndefined();
    expect(usedUpRest({ ...reading("adam", 100, 40), ok: false }, NOW)).toBeUndefined();
  });

  it.each([["5-hour", reading("adam", 100, 40)], ["7-day", reading("adam", 20, 100)]])("is resting and never picked at 100%% %s", (_label, adam) => {
    const { battery } = setup(adam);
    expect(battery.restOf(claude("adam"), ACCOUNTS)).toBeDefined();
    expect(battery.status(ACCOUNTS).resting.adam?.until).toBe(adam.weekly.usedPercent === 100 ? at(72 * HOUR) : at(2 * HOUR));
    expect(battery.route(ON_ADAM, ACCOUNTS).instanceId).not.toBe("adam");
    battery.markExhausted("home", { resetsAt: at(HOUR) });
    battery.markExhausted("beth", { resetsAt: at(HOUR) });
    battery.markExhausted("cara", { resetsAt: at(HOUR) });
    expect(battery.route({ instanceId: "home", model: "claude-opus-5" }, ACCOUNTS).instanceId).toBe("home");
  });

  it("moves a dog pinned to it, before and mid-turn, to the account with the most room", () => {
    const { battery } = setup(reading("adam", 100, 40), true);
    expect(battery.route(ON_ADAM, ACCOUNTS, "pinned-dog").instanceId).toBe("cara");
    battery.trackTurn("pinned-dog", { generation: "g1", instanceId: "adam", rerun: vi.fn(async () => undefined) });
    const moved = battery.nextAccount({ threadId: "pinned-dog", generation: "g1", stopReason: "usage_limit", ranOn: "adam", selection: ON_ADAM, accounts: ACCOUNTS });
    expect(moved?.to.instanceId).toBe("cara");
    expect(moved?.rest).toMatchObject({ until: at(2 * HOUR), kind: "session" });
  });

  it("is usable again once the reset time passes", () => {
    const { battery, advance } = setup(reading("adam", 100, 40), true);
    expect(battery.route(ON_ADAM, ACCOUNTS, "pinned-dog").instanceId).toBe("cara");
    advance(2 * HOUR + 1);
    expect(battery.restOf(claude("adam"), ACCOUNTS)).toBeUndefined();
    expect(battery.status(ACCOUNTS).resting.adam).toBeUndefined();
    expect(battery.route(ON_ADAM, ACCOUNTS, "pinned-dog")).toBe(ON_ADAM);
  });

  it("chooses the most room when a fallback runs out and the pinned account has recovered", () => {
    const { battery } = setup(reading("adam", 80, 40), true);
    battery.trackTurn("pinned-dog", { generation: "g1", instanceId: "beth", rerun: vi.fn(async () => undefined) });
    const moved = battery.nextAccount({ threadId: "pinned-dog", generation: "g1", stopReason: "usage_limit", ranOn: "beth", selection: ON_ADAM, accounts: ACCOUNTS });
    expect(moved?.to.instanceId).toBe("cara");
  });

  it("reports the same used-up state to the usage sheet and the account_usage tool", () => {
    const adam = reading("adam", 100, 40);
    const { battery } = setup(adam);
    const rest = (instanceId: string) => {
      const account = ACCOUNTS.find((candidate) => candidate.instanceId === instanceId);
      return account ? battery.restOf(account, ACCOUNTS) : undefined;
    };
    const report = withRestingUntil({ fetchedAt: at(0), providers: [adam, reading("cara", 10, 5)] }, rest);
    expect(report.providers.map((row) => row.restingUntil)).toEqual([at(2 * HOUR), undefined]);
    const usage = accountUsage(ACCOUNTS.map((account) => ({ account, row: reading(account.instanceId, account.instanceId === "adam" ? 100 : 10, 5), rest: rest(account.instanceId) })), "adam", NOW);
    expect(usage.accounts.find((row) => row.id === "adam")).toMatchObject({ status: "resting", restingUntil: at(2 * HOUR) });
    expect(usage.roomiest).not.toBe("adam");
  });

  it("tells the app when a reading turns an account used up", () => {
    const onChange = vi.fn();
    const readings: Record<string, PlanProviderRow> = { adam: reading("adam", 50, 40) };
    const battery = new AccountBattery({ config: () => ON, now: () => NOW, usage: (id) => readings[id], onChange });
    battery.noteReadings(ACCOUNTS);
    expect(onChange).not.toHaveBeenCalled();
    readings.adam = reading("adam", 100, 40);
    battery.noteReadings(ACCOUNTS);
    expect(onChange).toHaveBeenCalledOnce();
    battery.noteReadings(ACCOUNTS);
    expect(onChange).toHaveBeenCalledOnce();
  });
});
