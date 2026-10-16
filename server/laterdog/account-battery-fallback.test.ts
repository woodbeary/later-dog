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

describe("a turn that runs out of usage always moves on", () => {
  const fresh = () => new AccountBattery({ config: () => CONFIG, accounts: () => ACCOUNTS, now: () => NOW });

  it("moves to Codex when every Claude account is out, even when the limit that stopped it names another model family", () => {
    const battery = fresh();
    battery.markExhausted("claude-2", { resetsAt: at(HOUR) });
    battery.markExhausted("claude", { resetsAt: at(2 * HOUR), kind: "sonnet" });
    expect(battery.route(DOG, ACCOUNTS, "dog")).toBe(DOG);
    expect(ranOut(battery)).toMatchObject({ from: { instanceId: "claude" }, to: { instanceId: "chatgpt" } });
    expect(battery.route(DOG, ACCOUNTS, "dog")).toEqual({ instanceId: "chatgpt", model: "gpt-5.5" });
  });

  it("moves to Codex when the account it ran out on had no limit on record", () => {
    const battery = fresh();
    battery.markExhausted("claude-2", { resetsAt: at(HOUR) });
    expect(ranOut(battery)).toMatchObject({ from: { instanceId: "claude" }, to: { instanceId: "chatgpt" }, rest: { estimated: true } });
  });

  it("moves to Codex after the account's rest was cleared by a turn that finished on another model", () => {
    const battery = fresh();
    battery.markExhausted("claude-2", { resetsAt: at(HOUR) });
    battery.markExhausted("claude", { resetsAt: at(HOUR) });
    expect(battery.recovered("claude", NOW + 1)).toBe(true);
    expect(ranOut(battery)).toMatchObject({ to: { instanceId: "chatgpt" } });
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

  it("still skips a Codex account that is signed out or turned off", () => {
    for (const chatgpt of [codex("chatgpt", { signedIn: false }), codex("chatgpt", { enabled: false })]) {
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
