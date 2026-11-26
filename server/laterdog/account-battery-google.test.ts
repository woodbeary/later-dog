import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { googleUsageLimit } from "../drivers/acp/google-limits.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import {
  AccountBattery, BATTERY_DRIVERS, batteryOrder, checkBatteryConfig, engineName, googleKeyUse, withoutAccount,
  type AccountBatteryConfig, type BatteryAccount,
} from "./account-battery.ts";

const NOW = Date.parse("2026-11-26T20:00:00Z");
const HOUR = 3_600_000;
const FLASH = "gemini-3.8-flash-high";
const FLASH_LOW = "gemini-3.8-flash-low";
const PRO = "gemini-3.8-pro-high";

const antigravity = (instanceId: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "antigravityAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true,
  models: [FLASH, FLASH_LOW, PRO], defaultModel: FLASH, ...extra,
});
const ONE = antigravity("agy-one");
const TWO = antigravity("agy-two");
const ACCOUNTS = [ONE, TWO];
const ON: AccountBatteryConfig = { enabled: true, order: { antigravityAgent: ["agy-one", "agy-two"] } };
const SELECTION = { instanceId: "agy-one", model: FLASH };

const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "laterdog-battery-google-")); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

const battery = (now: () => number = () => NOW, config: () => AccountBatteryConfig | undefined = () => ON) =>
  new AccountBattery({ file: join(scratch(), "battery.json"), config, now, accounts: () => ACCOUNTS });

const weekly = (hours: number) => googleUsageLimit({ code: 429, message: `RESOURCE_EXHAUSTED (code 429): Individual quota reached. Contact your administrator to enable overages. Resets in ${hours}h.` }, "antigravity", NOW)!;

describe("Antigravity accounts in the battery", () => {
  it("counts Antigravity and Gemini among the engines the battery manages", () => {
    expect(BATTERY_DRIVERS).toEqual(expect.arrayContaining(["claudeAgent", "codex", "antigravityAgent", "geminiAgent"]));
    expect(engineName("antigravityAgent")).toBe("Antigravity");
    expect(engineName("geminiAgent")).toBe("Gemini");
  });

  it("orders each engine's eligible accounts, Antigravity among them", () => {
    const order = batteryOrder(ON, [...ACCOUNTS, antigravity("agy-three", { eligible: false })]);
    expect(order.antigravityAgent).toEqual(["agy-one", "agy-two"]);
    expect(batteryOrder(undefined, [])).toEqual({ claudeAgent: [], codex: [] });
  });

  it("turns itself on with two signed-in Antigravity accounts", () => {
    expect(battery(undefined, () => undefined).enabled).toBe(true);
    const lone = new AccountBattery({ file: join(scratch(), "battery.json"), config: () => undefined, now: () => NOW, accounts: () => [ONE] });
    expect(lone.enabled).toBe(false);
  });

  it("keeps a chat on its own account until that account is out", () => {
    expect(battery().route(SELECTION, ACCOUNTS, "thread")).toBe(SELECTION);
  });

  it("moves to the second account when the first reports its limit, and rests the first until its reset", () => {
    const instance = battery();
    const rest = instance.markExhausted("agy-one", weekly(53), FLASH);
    expect(rest.until).toBe(new Date(NOW + 53 * HOUR).toISOString());
    expect(instance.route(SELECTION, ACCOUNTS, "thread")).toEqual({ instanceId: "agy-two", model: FLASH });
    expect(instance.restOf(ONE, ACCOUNTS, FLASH)?.until).toBe(rest.until);
  });

  it("rests only the model group that ran out, so another group on the same account still runs", () => {
    const instance = battery();
    instance.markExhausted("agy-one", weekly(53), FLASH);
    expect(instance.restOf(ONE, ACCOUNTS, FLASH_LOW)?.until).toBe(new Date(NOW + 53 * HOUR).toISOString());
    expect(instance.restOf(ONE, ACCOUNTS, PRO)).toBeUndefined();
    expect(instance.route({ instanceId: "agy-one", model: PRO }, ACCOUNTS, "pro-thread")).toEqual({ instanceId: "agy-one", model: PRO });
    expect(instance.status(ACCOUNTS).modelResting["agy-one"]).toEqual([expect.objectContaining({ model: "gemini-3.8-flash", until: new Date(NOW + 53 * HOUR).toISOString() })]);
  });

  it("returns to the first account once its reset passes", () => {
    let now = NOW;
    const instance = battery(() => now);
    instance.markExhausted("agy-one", weekly(5), FLASH);
    expect(instance.route(SELECTION, ACCOUNTS).instanceId).toBe("agy-two");
    now = NOW + 5 * HOUR + 1000;
    expect(instance.route(SELECTION, ACCOUNTS)).toBe(SELECTION);
    expect(instance.restOf(ONE, ACCOUNTS, FLASH)).toBeUndefined();
  });

  it("waits for the first reset when both accounts are out", () => {
    const instance = battery();
    instance.markExhausted("agy-one", weekly(5), FLASH);
    instance.markExhausted("agy-two", weekly(9), FLASH);
    expect(instance.readyAt(SELECTION, ACCOUNTS, "thread")).toBe(new Date(NOW + 5 * HOUR).toISOString());
  });

  it("uses its default rest when the provider names no time, and ends it early after a good turn", () => {
    const instance = battery();
    const limit = googleUsageLimit({ code: 429, message: "Resource has been exhausted (e.g. check quota)." }, "antigravity", NOW)!;
    const rest = instance.markExhausted("agy-one", limit, FLASH);
    expect(rest.estimated).toBe(true);
    expect(Date.parse(rest.until) - NOW).toBe(5 * HOUR);
    expect(instance.recovered("agy-one", NOW + 1, FLASH)).toBe(true);
    expect(instance.restOf(ONE, ACCOUNTS, FLASH)).toBeUndefined();
  });

  it("never reports a paid-credit state for an account without a usage reading", () => {
    const instance = battery();
    instance.markExhausted("agy-one", weekly(5), FLASH);
    const choice = instance.decide(SELECTION, ACCOUNTS, "thread");
    expect(choice).toMatchObject({ kind: expect.not.stringMatching(/credits/) });
    expect(JSON.stringify(instance.status(ACCOUNTS))).not.toMatch(/credits/i);
  });

  it("survives a restart with its rests", () => {
    const file = join(scratch(), "battery.json");
    const first = new AccountBattery({ file, config: () => ON, now: () => NOW, accounts: () => ACCOUNTS });
    first.markExhausted("agy-one", weekly(53), FLASH);
    const second = new AccountBattery({ file, config: () => ON, now: () => NOW, accounts: () => ACCOUNTS });
    expect(second.restOf(ONE, ACCOUNTS, FLASH)?.until).toBe(new Date(NOW + 53 * HOUR).toISOString());
  });

  it("rests a whole Gemini account for a spending cap, whatever model ran", () => {
    const instance = battery();
    const cap = googleUsageLimit({ code: 429, message: "Your project has exceeded its monthly spending cap." }, "gemini", NOW)!;
    instance.markExhausted("agy-one", cap, FLASH);
    expect(instance.restOf(ONE, ACCOUNTS, PRO)).toBeTruthy();
  });
});

describe("Gemini key accounts", () => {
  const key = (instanceId: string, eligible: boolean): BatteryAccount => ({
    instanceId, driverKind: "geminiAgent", displayName: instanceId, enabled: true, eligible, signedIn: true, models: ["gemini-2.5-pro"],
  });
  const accounts = [key("gemini-a", true), key("gemini-b", false)];

  it("reads which keys are marked", () => {
    const config = { enabled: true, order: {}, googleKeys: { "gemini-a": "free", "gemini-b": "paid" } } as const;
    expect(googleKeyUse(config, "gemini-a")).toBe("free");
    expect(googleKeyUse(config, "gemini-b")).toBe("paid");
    expect(googleKeyUse(config, "gemini-c")).toBeUndefined();
    expect(googleKeyUse(undefined, "gemini-a")).toBeUndefined();
    expect(googleKeyUse({ enabled: true, order: {}, googleKeys: { toString: "free" } as never }, "toString")).toBe("free");
    expect(googleKeyUse({ enabled: true, order: {} }, "toString")).toBeUndefined();
  });

  it("saves a marked key and refuses a mark on anything else", () => {
    const saved = checkBatteryConfig({ googleKeys: { "gemini-a": "free" } }, accounts);
    expect(saved).toMatchObject({ ok: true, config: { googleKeys: { "gemini-a": "free" } } });
    expect(checkBatteryConfig({ googleKeys: { "agy-one": "free" } }, [...accounts, ONE])).toMatchObject({ ok: false });
    expect(checkBatteryConfig({ googleKeys: { "gemini-a": "other" as never } }, accounts)).toMatchObject({ ok: false });
  });

  it("clears every mark when an empty set is saved", () => {
    const current = { enabled: true, order: {}, googleKeys: { "gemini-a": "free" as const } };
    const cleared = checkBatteryConfig({ googleKeys: {} }, accounts, current);
    expect(cleared).toMatchObject({ ok: true, config: { googleKeys: {} } });
  });

  it("keeps the marks when other settings change", () => {
    const current = { enabled: true, order: {}, googleKeys: { "gemini-a": "paid" as const } };
    expect(checkBatteryConfig({ auto: true }, accounts, current)).toMatchObject({ ok: true, config: { googleKeys: { "gemini-a": "paid" }, auto: true } });
  });

  it("puts only marked keys in the order, and drops a key's mark with its account", () => {
    expect(batteryOrder(ON, accounts).geminiAgent).toEqual(["gemini-a"]);
    const config = { enabled: true, order: {}, googleKeys: { "gemini-a": "free" as const, "gemini-b": "paid" as const } };
    expect(withoutAccount(config, "gemini-a")?.googleKeys).toEqual({ "gemini-b": "paid" });
    expect(withoutAccount({ enabled: true, order: {} }, "gemini-a")).toBeUndefined();
  });

  it("rests a Gemini key until midnight Pacific for a daily quota and keeps its other model running", () => {
    const instance = new AccountBattery({ file: join(scratch(), "battery.json"), config: () => undefined, now: () => NOW, accounts: () => accounts });
    const limit = googleUsageLimit({ code: 429, message: "You have exhausted your daily quota on this model." }, "gemini", NOW)!;
    const rest = instance.markExhausted("gemini-a", limit, "gemini-2.5-pro");
    expect(rest.until).toBe("2026-11-27T08:00:00.000Z");
    expect(instance.restOf(accounts[0]!, accounts, "gemini-2.5-flash")).toBeUndefined();
  });
});
