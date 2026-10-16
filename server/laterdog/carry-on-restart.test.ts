import { describe, expect, it, vi } from "vitest";
import { AccountBattery, CONTINUE_AFTER_RESET, type AccountBatteryConfig, type BatteryAccount } from "./account-battery.ts";
import { carryOnAfterRestart, type RestartInput } from "./carry-on-restart.ts";

const NOW = Date.parse("2026-10-15T18:00:00Z");
const HOUR = 3600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const claude = (instanceId: string): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: `Claude ${instanceId}`, enabled: true, eligible: true, signedIn: true, models: ["claude-opus-5"],
});
const ACCOUNTS = [claude("one"), claude("two")];
const CONFIG: AccountBatteryConfig = { enabled: true, order: { claudeAgent: ["one", "two"] } };
const DOG = { instanceId: "one", model: "claude-opus-5" };
const PATH = [
  { id: "ask", role: "user", kind: "text" },
  { id: "work", role: "bot", kind: "activity", tool: { name: "Bash", ok: true, itemId: "item-1" } },
  { id: "limit", role: "bot", kind: "activity", tool: { name: "error: You've hit your limit", ok: false, quota: { instanceId: "one" } } },
];

function setup(overrides: Partial<RestartInput> = {}, config: AccountBatteryConfig = CONFIG) {
  const battery = new AccountBattery({ config: () => config, accounts: () => ACCOUNTS, now: () => NOW });
  const write = vi.fn();
  const start = vi.fn(async () => undefined);
  const input: RestartInput = { battery, accounts: ACCOUNTS, threadId: "dog", selection: DOG, path: PATH, full: false, write, start, ...overrides };
  return { battery, write, start, input };
}

describe("picking up a conversation that waited on a usage limit across a restart", () => {
  it("replaces the limit row with a line saying where it picks up, and continues the person's request without redoing it", () => {
    const { battery, write, start, input } = setup();
    battery.markExhausted("one", { resetsAt: at(HOUR) });
    expect(carryOnAfterRestart(input)).toBe("started");
    expect(write).toHaveBeenCalledExactlyOnceWith({ name: "recovery: Picking up where it stopped, on Claude two.", ok: true, carry: { from: "one", to: "two" } }, "limit");
    expect(start).toHaveBeenCalledExactlyOnceWith(CONTINUE_AFTER_RESET, "ask");
    expect(battery.arrive("dog", DOG, "two", ACCOUNTS)).toBeUndefined();
  });

  it("goes back on its own account once that one reset", () => {
    const { write, start, input } = setup();
    expect(carryOnAfterRestart(input)).toBe("started");
    expect(write.mock.calls[0]![0]).toMatchObject({ carry: { from: "one", to: "one" } });
    expect(start).toHaveBeenCalledOnce();
  });

  it("waits again when every account is still out, and for a free slot when the dog is busy", () => {
    const waiting = setup();
    waiting.battery.markExhausted("one", { resetsAt: at(HOUR) });
    waiting.battery.markExhausted("two", { resetsAt: at(HOUR) });
    expect(carryOnAfterRestart(waiting.input)).toBe("waiting");
    const full = setup({ full: true });
    expect(carryOnAfterRestart(full.input)).toBe("full");
    expect([...waiting.write.mock.calls, ...waiting.start.mock.calls, ...full.write.mock.calls, ...full.start.mock.calls]).toEqual([]);
  });

  it("lets go when keep-going is off, the person wrote since, or nothing stopped on a limit", () => {
    const outcomes = [
      setup({}, { ...CONFIG, enabled: false }).input,
      setup({ path: [...PATH, { id: "newer", role: "user", kind: "text" }] }).input,
      setup({ path: PATH.slice(0, 2) }).input,
      setup({ path: [] }).input,
    ].map(carryOnAfterRestart);
    expect(outcomes).toEqual(["skipped", "skipped", "skipped", "skipped"]);
  });

  it("says so in the chat when the continued turn cannot start", async () => {
    const { write, input } = setup({ start: async () => { throw new Error("provider settings are being updated"); } });
    expect(carryOnAfterRestart(input)).toBe("started");
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[1]![0]).toMatchObject({ ok: false, name: expect.stringContaining("Could not carry on with Claude one: provider settings are being updated") });
  });
});
