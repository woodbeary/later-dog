import { describe, expect, it, vi } from "vitest";
import { AccountBattery, type AccountBatteryConfig, type BatteryAccount } from "./account-battery.ts";
import { checkContinueOn } from "./continue-on-account.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const HOUR = 3600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

const account = (instanceId: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true,
  models: ["claude-fable-5-2"], defaultModel: "claude-fable-5-2", ...extra,
});
const ACCOUNTS = [account("daniel"), account("work"), account("codex", { driverKind: "codex", models: ["gpt-5.5"], defaultModel: "gpt-5.5" })];
const CONFIG: AccountBatteryConfig = { enabled: true, order: { claudeAgent: ["daniel", "work"], codex: ["codex"] } };
const ON_DANIEL = { instanceId: "daniel", model: "claude-fable-5-2" };

function setup() {
  const battery = new AccountBattery({
    config: () => CONFIG, accounts: () => ACCOUNTS, now: () => NOW, running: () => ({}), defaultAccount: () => "daniel",
    ownThread: () => true, pinnedThread: (threadId) => threadId === "atelier",
  });
  battery.markExhausted("daniel", { resetsAt: at(3 * HOUR) });
  battery.markExhausted("work", { resetsAt: at(HOUR) });
  return battery;
}

describe("a dog pinned to an account when every account of its engine is resting", () => {
  it("stays on its engine and waits for the soonest reset there", () => {
    const battery = setup();
    expect(battery.route(ON_DANIEL, ACCOUNTS, "atelier")).toEqual(ON_DANIEL);
    expect(battery.readyAt(ON_DANIEL, ACCOUNTS, "atelier")).toBe(at(HOUR));
  });

  it("does not carry a turn that ran out over to another engine", () => {
    const battery = setup();
    battery.trackTurn("atelier", { generation: "g1", instanceId: "daniel", rerun: vi.fn(async () => undefined) });
    expect(battery.nextAccount({ threadId: "atelier", generation: "g1", stopReason: "usage_limit", ranOn: "daniel", selection: ON_DANIEL, accounts: ACCOUNTS })).toBeNull();
  });

  it("still moves to another account of its engine that has room", () => {
    const battery = setup();
    battery.recovered("work", NOW + 1);
    expect(battery.route(ON_DANIEL, ACCOUNTS, "atelier").instanceId).toBe("work");
    expect(battery.readyAt(ON_DANIEL, ACCOUNTS, "atelier")).toBeUndefined();
  });

  it("goes to another engine when you pick it by hand", () => {
    const battery = setup();
    battery.choose("atelier", "daniel", "codex", "daniel");
    expect(battery.route(ON_DANIEL, ACCOUNTS, "atelier").instanceId).toBe("codex");
  });
});

describe("a dog that is not pinned", () => {
  it("keeps going on another engine when its own is resting", () => {
    const battery = setup();
    expect(battery.route(ON_DANIEL, ACCOUNTS, "other").instanceId).toBe("codex");
    expect(battery.readyAt(ON_DANIEL, ACCOUNTS, "other")).toBeUndefined();
    battery.trackTurn("other", { generation: "g1", instanceId: "daniel", rerun: vi.fn(async () => undefined) });
    expect(battery.nextAccount({ threadId: "other", generation: "g1", stopReason: "usage_limit", ranOn: "daniel", selection: ON_DANIEL, accounts: ACCOUNTS })?.to.instanceId).toBe("codex");
  });
});

describe("continuing a pinned dog on another account", () => {
  const check = (to: string, extra: { pinned?: boolean; byHand?: boolean } = {}) => checkContinueOn({
    accounts: ACCOUNTS, selection: ON_DANIEL, from: "daniel", to, resting: () => false, ...extra,
  });

  it("refuses another engine unless you picked it by hand", () => {
    expect(check("codex", { pinned: true })).toEqual({ ok: false, status: 409, error: "This dog stays on Claude." });
    expect(check("codex", { pinned: true, byHand: true }).ok).toBe(true);
    expect(check("work", { pinned: true }).ok).toBe(true);
    expect(check("codex").ok).toBe(true);
  });
});
