import { describe, expect, it } from "vitest";
import { AccountBattery, type BatteryAccount } from "./account-battery.ts";
import { BATTERY_FIELDS, guestBattery, type BatteryView } from "./battery-view.ts";

const NOW = Date.parse("2026-11-12T18:00:00Z");
const account = (instanceId: string): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true, models: ["claude-opus-5"],
});
const ACCOUNTS = [account("one"), account("two")];

function view(): BatteryView {
  const battery = new AccountBattery({ config: () => ({ enabled: true, order: { claudeAgent: ["one", "two"] } }), now: () => NOW });
  battery.markExhausted("one", { resetsAt: new Date(NOW + 3600_000).toISOString() });
  const choice = (threadId: string) => ({ instanceId: threadId === "picked" ? "two" : "one", model: "claude-opus-5" });
  const status = battery.status(ACCOUNTS, choice, [["covered", { on: "two", model: "claude-opus-5" }], ["picked", { on: "one", model: "claude-opus-5" }]]);
  return { ...status, waiting: { held: new Date(NOW + 3600_000).toISOString() } };
}

describe("what a guest sees of the account battery", () => {
  it("covers every field the server sends, so a new per-chat record cannot reach guests unnoticed", () => {
    expect(Object.keys(view()).sort()).toEqual(Object.keys(BATTERY_FIELDS).sort());
  });

  it("gets no chat's thread id, account or model, and keeps what everyone may see", () => {
    const full = view();
    expect(Object.keys(full.routed)).toEqual(["covered"]);
    expect(Object.keys(full.fromNextMessage)).toEqual(["picked"]);
    const guest = guestBattery(full);
    for (const [key, reach] of Object.entries(BATTERY_FIELDS)) {
      expect(guest[key as keyof BatteryView], key).toEqual(reach === "per-chat" ? {} : full[key as keyof BatteryView]);
    }
    expect(JSON.stringify(guest)).not.toMatch(/covered|picked|held/);
  });
});
