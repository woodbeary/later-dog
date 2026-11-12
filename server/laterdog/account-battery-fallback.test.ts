import { describe, expect, it } from "vitest";
import { AccountBattery, type AccountBatteryConfig, type BatteryAccount } from "./account-battery.ts";

const NOW = Date.parse("2026-10-15T18:00:00Z");
const HOUR = 3600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const claude = (instanceId: string): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true,
  models: ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"],
});
const codex = (instanceId: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "codex", displayName: instanceId, enabled: true, eligible: true, signedIn: true, models: ["gpt-5.5"], defaultModel: "gpt-5.5", ...extra,
});
const ACCOUNTS = [claude("claude"), claude("claude-2"), codex("chatgpt")];
const CONFIG: AccountBatteryConfig = { enabled: true, order: { claudeAgent: ["claude", "claude-2"], codex: ["chatgpt"] } };
const DOG = { instanceId: "claude", model: "claude-fable-5-1" };

function ranOut(battery: AccountBattery, accounts = ACCOUNTS, ranOn = "claude") {
  battery.trackTurn("dog", { generation: "g", instanceId: ranOn, requestMessageId: "ask", rerun: async () => undefined });
  return battery.nextAccount({ threadId: "dog", generation: "g", stopReason: "usage_limit", ranOn, selection: DOG, accounts });
}

describe("a turn that runs out of usage moves on within its engine, or waits", () => {
  const fresh = () => new AccountBattery({ config: () => CONFIG, accounts: () => ACCOUNTS, now: () => NOW });

  it("moves to another Claude account that can run, even when the limit that stopped it names another model family", () => {
    const battery = fresh();
    battery.markExhausted("claude", { resetsAt: at(2 * HOUR), kind: "sonnet" });
    expect(battery.route(DOG, ACCOUNTS, "dog")).toBe(DOG);
    expect(ranOut(battery)).toMatchObject({ from: { instanceId: "claude" }, to: { instanceId: "claude-2" } });
    expect(battery.route(DOG, ACCOUNTS, "dog")).toEqual({ ...DOG, instanceId: "claude-2" });
  });

  it("waits instead of moving to Codex when every Claude account is out, with or without a limit on record", () => {
    for (const limit of [true, false]) {
      const battery = fresh();
      battery.markExhausted("claude-2", { resetsAt: at(HOUR) });
      if (limit) battery.markExhausted("claude", { resetsAt: at(2 * HOUR), kind: "sonnet" });
      expect(ranOut(battery)).toBeNull();
      expect(battery.route(DOG, ACCOUNTS, "dog")).toBe(DOG);
      expect(battery.readyAt(DOG, ACCOUNTS, "dog")).toBe(at(HOUR));
    }
  });

  it("records the rest of an account that ran out after its earlier rest was cleared", () => {
    const battery = fresh();
    battery.markExhausted("claude-2", { resetsAt: at(HOUR) });
    battery.markExhausted("claude", { resetsAt: at(HOUR) });
    expect(battery.recovered("claude", NOW + 1)).toBe(true);
    expect(ranOut(battery)).toBeNull();
    expect(battery.restOf(ACCOUNTS[0]!, ACCOUNTS)).toMatchObject({ estimated: true });
  });

  it("waits for a reset it knows when every account is out, instead of stopping with nothing to wake it", () => {
    const battery = fresh();
    battery.markExhausted("claude-2", { resetsAt: at(HOUR) });
    battery.markExhausted("chatgpt", { resetsAt: at(3 * HOUR) });
    expect(ranOut(battery)).toBeNull();
    expect(battery.readyAt(DOG, ACCOUNTS, "dog")).toBe(at(HOUR));
  });

  it("records the rest even for a turn it cannot run again, so the conversation still waits for a reset", () => {
    const battery = fresh();
    battery.markExhausted("claude-2", { resetsAt: at(HOUR) });
    battery.markExhausted("chatgpt", { resetsAt: at(HOUR) });
    expect(battery.nextAccount({ threadId: "untracked", generation: undefined, stopReason: "usage_limit", ranOn: "claude", selection: DOG, accounts: ACCOUNTS })).toBeNull();
    expect(battery.readyAt(DOG, ACCOUNTS, "untracked")).toBe(at(HOUR));
  });

  it("never takes a Codex account, signed in or not", () => {
    for (const chatgpt of [codex("chatgpt"), codex("chatgpt", { signedIn: false }), codex("chatgpt", { enabled: false })]) {
      const accounts = [claude("claude"), claude("claude-2"), chatgpt];
      const battery = new AccountBattery({ config: () => CONFIG, accounts: () => accounts, now: () => NOW });
      battery.markExhausted("claude-2", { resetsAt: at(HOUR) });
      expect(ranOut(battery, accounts)).toBeNull();
    }
  });

  it("does not leave the engine while keep-going is off", () => {
    const battery = new AccountBattery({ config: () => ({ ...CONFIG, enabled: false }), accounts: () => ACCOUNTS, now: () => NOW });
    expect(ranOut(battery)).toBeNull();
    expect(battery.readyAt(DOG, ACCOUNTS, "dog")).toBeDefined();
  });
});

describe("a dog whose account needs setup moves to a working one", () => {
  const usage = (left: Record<string, number>) => (id: string) => ({
    ok: true, fiveHour: { available: true, usedPercent: 100 - (left[id] ?? 50), resetsAt: at(HOUR) }, weekly: { available: true, usedPercent: 0, resetsAt: at(48 * HOUR) },
  }) as never;
  const accounts = [claude("claude"), claude("claude-2"), claude("claude-3")];
  const config: AccountBatteryConfig = { enabled: true, auto: true, order: { claudeAgent: ["claude", "claude-2", "claude-3"] } };

  it("moves the failed turn to the account with the most left and says the old one needs signing in again", async () => {
    const { switchNotice } = await import("./account-battery.ts");
    const battery = new AccountBattery({ config: () => config, accounts: () => accounts, now: () => NOW, usage: usage({ "claude-2": 30, "claude-3": 80 }) });
    battery.trackTurn("dog", { generation: "g", instanceId: "claude", requestMessageId: "ask", rerun: async () => undefined });
    const next = battery.nextAccount({ threadId: "dog", generation: "g", stopReason: "setup", ranOn: "claude", selection: DOG, accounts });
    expect(next).toMatchObject({ from: { instanceId: "claude" }, to: { instanceId: "claude-3" }, reason: "setup", rest: { kind: "setup" } });
    expect(switchNotice({ to: "claude-3", from: "claude", rest: next!.rest, now: NOW })).toBe("Switched to claude-3 — claude needs signing in again.");
  });

  it("keeps new turns off the broken account until it is checked again", () => {
    const battery = new AccountBattery({ config: () => config, accounts: () => accounts, now: () => NOW, usage: usage({ "claude-2": 30, "claude-3": 80 }) });
    battery.needsSetup("claude");
    expect(battery.route(DOG, accounts, "dog").instanceId).not.toBe("claude");
    const later = new AccountBattery({ config: () => config, accounts: () => accounts, now: () => NOW + 31 * 60_000, usage: usage({}) });
    expect(later.route(DOG, accounts, "dog")).toBe(DOG);
  });
});
