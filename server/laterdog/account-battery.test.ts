import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanProviderRow } from "../plan-usage.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import {
  AccountBattery, DEFAULT_REST_MS, backNotice, batteryEnabled, chosenModelOn, crossEngineNotice, engineName, selectionOnAccount, batterySequence, batteryOrder, checkBatteryConfig, effectiveOrder, limitRowToReplace, percentLeft, planResetAt, resetLabel, routeSelection,
  routedNotice, switchNotice, withoutAccount,
  type AccountBatteryConfig, type BatteryAccount, type Rest,
} from "./account-battery.ts";

const NOW = Date.parse("2026-10-07T18:30:00Z");
const HOUR = 3600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

const account = (instanceId: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true,
  models: ["claude-sonnet-5", "claude-opus-5"], ...extra,
});
const ACCOUNTS = [account("claude"), account("claude-b"), account("claude-c")];
const ON: AccountBatteryConfig = { enabled: true, order: { claudeAgent: ["claude-b", "claude", "claude-c"] } };
const SELECTION = { instanceId: "claude", model: "claude-sonnet-5", effort: "high" as const };
const route = (overrides: Partial<Parameters<typeof routeSelection>[0]> = {}) =>
  routeSelection({ config: ON, selection: SELECTION, accounts: ACCOUNTS, resting: {}, now: NOW, ...overrides });
const rest = (offset: number, extra: Partial<Rest> = {}): Rest => ({ until: at(offset), since: at(0), ...extra });

const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "laterdog-battery-")); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

describe("routing", () => {
  it("changes nothing while the battery is off or for an account it does not manage", () => {
    expect(route({ config: { ...ON, enabled: false } })).toBe(SELECTION);
    expect(route({ config: undefined })).toBe(SELECTION);
    const api = { ...SELECTION, instanceId: "claudeApi" };
    expect(route({ selection: api, accounts: [...ACCOUNTS, account("claudeApi", { eligible: false })] })).toBe(api);
    expect(route({ selection: { ...SELECTION, instanceId: "codex" } })).toEqual({ ...SELECTION, instanceId: "codex" });
  });

  it("runs on the account the conversation picked, keeping the model, effort and variant", () => {
    expect(route()).toBe(SELECTION);
    const picked = { instanceId: "claude-c", model: "claude-opus-5", variant: "fast" };
    expect(route({ selection: picked })).toBe(picked);
  });

  it("passes over a resting, disabled or signed-out pick to the next account in the order", () => {
    const resting = { claude: rest(HOUR) };
    expect(route({ resting })).toEqual({ ...SELECTION, instanceId: "claude-b" });
    expect(route({ resting: { ...resting, "claude-b": rest(2 * HOUR) } })).toEqual({ ...SELECTION, instanceId: "claude-c" });
    expect(route({ accounts: [account("claude", { enabled: false }), account("claude-b"), account("claude-c")] }).instanceId).toBe("claude-b");
    expect(route({ accounts: [account("claude", { signedIn: false }), account("claude-b"), account("claude-c")] }).instanceId).toBe("claude-b");
    expect(route({ resting, accounts: [account("claude"), account("claude-b", { models: ["claude-opus-5"] }), account("claude-c")] }).instanceId).toBe("claude-c");
    expect(route({ resting, accounts: [account("claude"), account("claude-b", { signedIn: undefined }), account("claude-c")] }).instanceId).toBe("claude-b");
    expect(route({ resting, selection: { ...SELECTION, model: "claude-custom-fixture" } }).instanceId).toBe("claude-b");
  });

  it("comes back to the pick once its limit has reset, and keeps it when every account rests", () => {
    expect(route({ resting: { claude: rest(-1) } })).toBe(SELECTION);
    expect(route({ resting: { "claude-b": rest(HOUR), claude: rest(HOUR), "claude-c": rest(HOUR) } })).toBe(SELECTION);
  });

  it("stops only that model family for an Opus or Sonnet limit", () => {
    const opus = { claude: rest(HOUR, { kind: "opus" }) };
    expect(route({ resting: opus })).toBe(SELECTION);
    expect(route({ resting: opus, selection: { ...SELECTION, model: "claude-opus-5" } }).instanceId).toBe("claude-b");
  });

  it("rests accounts signed in to the same login together", () => {
    const twins = [account("claude", { email: "me@example.test" }), account("claude-b", { email: "work@example.test" }), account("claude-c", { email: "ME@example.test" })];
    const resting = { claude: rest(HOUR) };
    expect(route({ accounts: twins, resting, config: { enabled: true, order: { claudeAgent: ["claude", "claude-c", "claude-b"] } } }).instanceId).toBe("claude-b");
  });

  it("can continue a Codex conversation on the next provider in the complete list", () => {
    const codex = (instanceId: string) => account(instanceId, { driverKind: "codex", models: ["gpt-5.5-codex"] });
    const accounts = [...ACCOUNTS, codex("chatgpt"), codex("chatgpt-b")];
    const config = { enabled: true, order: { ...ON.order, codex: ["chatgpt-b", "chatgpt"] } };
    const selection = { instanceId: "chatgpt", model: "gpt-5.5-codex" };
    expect(route({ config, accounts, selection })).toBe(selection);
    expect(route({ config, accounts, selection, resting: { chatgpt: rest(HOUR) } })).toEqual({ instanceId: "claude-b", model: "claude-sonnet-5" });
    expect(route({ config, accounts, selection, resting: { "chatgpt-b": rest(HOUR), chatgpt: rest(HOUR) } })).toEqual({ instanceId: "claude-b", model: "claude-sonnet-5" });
  });

  it("orders the saved accounts first, then any added since, without removed or ineligible ones", () => {
    const accounts = [...ACCOUNTS, account("claude-new"), account("claudeApi", { eligible: false })];
    expect(batteryOrder({ enabled: true, order: { claudeAgent: ["claude-c", "gone", "claudeApi", "claude"] } }, accounts))
      .toEqual({ claudeAgent: ["claude-c", "claude", "claude-b", "claude-new"], codex: [] });
    expect(batteryOrder(undefined, accounts)).toEqual({ claudeAgent: ["claude", "claude-b", "claude-c", "claude-new"], codex: [] });
  });
});

describe("settings", () => {
  it("accepts only Claude and Codex subscription accounts, each once, each in its own engine's order", () => {
    expect(checkBatteryConfig({ enabled: true, order: { claudeAgent: ["claude-b", "claude", "claude-b"] } }, ACCOUNTS))
      .toEqual({ ok: true, config: { enabled: true, order: { claudeAgent: ["claude-b", "claude"] } } });
    const codex = [account("chatgpt", { driverKind: "codex" }), account("chatgpt-b", { driverKind: "codex" })];
    expect(checkBatteryConfig({ enabled: true, order: { codex: ["chatgpt-b", "chatgpt"] } }, [...ACCOUNTS, ...codex]))
      .toEqual({ ok: true, config: { enabled: true, order: { codex: ["chatgpt-b", "chatgpt"] } } });
    expect(checkBatteryConfig({ enabled: true, order: { codex: ["claude"] } }, [...ACCOUNTS, ...codex])).toMatchObject({ ok: false, error: expect.stringContaining("claude") });
    expect(checkBatteryConfig({ enabled: true, order: { grokAgent: ["grok"] } }, ACCOUNTS)).toMatchObject({ ok: false, error: expect.stringMatching(/Claude and Codex accounts only/) });
    expect(checkBatteryConfig({ enabled: true, order: { claudeAgent: ["claudeApi"] } }, [...ACCOUNTS, account("claudeApi", { eligible: false })]))
      .toMatchObject({ ok: false, error: expect.stringContaining("claudeApi") });
    expect(checkBatteryConfig({ enabled: false, order: {} }, ACCOUNTS)).toEqual({ ok: true, config: { enabled: false, order: {} } });
  });

  it("lets a removed account go from the order", () => {
    expect(withoutAccount(ON, "claude")).toEqual({ enabled: true, order: { claudeAgent: ["claude-b", "claude-c"] } });
    expect(withoutAccount({ ...ON, auto: true }, "claude")).toEqual({ enabled: true, order: { claudeAgent: ["claude-b", "claude-c"] }, auto: true });
    expect(withoutAccount(ON, "elsewhere")).toBeUndefined();
    expect(withoutAccount(undefined, "claude")).toBeUndefined();
  });

  it("keeps the saved order and the other switches when only part of the setting changes", () => {
    const current = { enabled: true, order: { claudeAgent: ["claude-c", "claude"] } };
    expect(checkBatteryConfig({ auto: true }, ACCOUNTS, current)).toEqual({ ok: true, config: { ...current, auto: true } });
    expect(checkBatteryConfig({ enabled: false }, ACCOUNTS, { ...current, auto: true })).toEqual({ ok: true, config: { enabled: false, order: current.order, auto: true } });
    expect(checkBatteryConfig({ auto: false }, ACCOUNTS, { ...current, auto: true })).toEqual({ ok: true, config: { ...current, auto: false } });
    expect(checkBatteryConfig({ order: { claudeAgent: ["claude-b"] } }, ACCOUNTS, current)).toEqual({ ok: true, config: { enabled: true, order: { claudeAgent: ["claude-b"] } } });
    expect(checkBatteryConfig({ order: { claudeAgent: ["nobody"] } }, ACCOUNTS, current)).toMatchObject({ ok: false, error: expect.stringContaining("nobody") });
    expect(checkBatteryConfig({ auto: true }, ACCOUNTS)).toEqual({ ok: true, config: { enabled: true, order: {}, auto: true } });
  });
});

describe("most available first", () => {
  const closed = { available: false, usedPercent: null, remainingPercent: null, resetsAt: null };
  const open = (used: number, resetsAt: string) => ({ available: true, usedPercent: used, remainingPercent: 100 - used, resetsAt });
  const reading = (id: string, fiveHour: number | null, weekly: number | null, extra: { fiveHourResets?: string; ok?: boolean } = {}): PlanProviderRow => ({
    id, name: id, driver: "claude", plan: "Max", ok: extra.ok ?? true, error: null,
    fiveHour: fiveHour === null ? closed : open(fiveHour, extra.fiveHourResets ?? at(2 * HOUR)),
    weekly: weekly === null ? closed : open(weekly, at(72 * HOUR)),
    extra: [], models: [],
  });
  const AUTO: AccountBatteryConfig = { ...ON, auto: true };

  it("reads what is left as the tighter of the 5-hour and weekly windows, counting a window that has reset as full", () => {
    expect(percentLeft(reading("claude", 30, 80), NOW)).toBe(20);
    expect(percentLeft(reading("claude", 90, 10), NOW)).toBe(10);
    expect(percentLeft(reading("claude", 90, null), NOW)).toBe(10);
    expect(percentLeft(reading("claude", 90, 10, { fiveHourResets: at(-1) }), NOW)).toBe(90);
    expect(percentLeft(reading("claude", null, null), NOW)).toBeUndefined();
    expect(percentLeft(reading("claude", 30, 80, { ok: false }), NOW)).toBeUndefined();
    expect(percentLeft(undefined, NOW)).toBeUndefined();
  });

  it("ranks by what is left, resting accounts last and unknown usage after known, with the saved order breaking ties", () => {
    const accounts = [...ACCOUNTS, account("claude-d"), account("claude-e")];
    const saved = { ...AUTO, order: { claudeAgent: ["claude-b", "claude", "claude-c", "claude-d", "claude-e"] } };
    const readings: Record<string, PlanProviderRow> = {
      claude: reading("claude", 20, 30), "claude-b": reading("claude-b", 70, 10), "claude-c": reading("claude-c", 10, 30), "claude-e": reading("claude-e", 0, 0),
    };
    const order = (config: AccountBatteryConfig) =>
      effectiveOrder({ config, accounts, resting: { "claude-e": rest(HOUR) }, now: NOW, usage: (id) => readings[id] }).claudeAgent;
    expect(order(saved)).toEqual(["claude", "claude-c", "claude-b", "claude-d", "claude-e"]);
    expect(order({ ...saved, auto: false })).toEqual(saved.order.claudeAgent);
    expect(order({ ...saved, enabled: false })).toEqual(saved.order.claudeAgent);
    expect(effectiveOrder({ config: saved, accounts, resting: {}, now: NOW }).claudeAgent).toEqual(saved.order.claudeAgent);
  });

  it("still runs on the pick while it can, then on the account with the most left", () => {
    const readings: Record<string, PlanProviderRow> = {
      claude: reading("claude", 50, 50), "claude-b": reading("claude-b", 90, 20), "claude-c": reading("claude-c", 40, 10),
    };
    const usage = (id: string) => readings[id];
    expect(route({ config: AUTO, usage })).toBe(SELECTION);
    expect(route({ config: AUTO, usage, resting: { claude: rest(HOUR) } }).instanceId).toBe("claude-c");
    expect(route({ config: ON, usage, resting: { claude: rest(HOUR) } }).instanceId).toBe("claude-b");
  });

  it("reports the order it will use and moves a turn that ran out to the account with the most left", () => {
    const readings: Record<string, PlanProviderRow> = {
      claude: reading("claude", 100, 40), "claude-b": reading("claude-b", 90, 20), "claude-c": reading("claude-c", 40, 10),
    };
    const instance = new AccountBattery({ config: () => AUTO, now: () => NOW, usage: (id) => readings[id] });
    expect(instance.status(ACCOUNTS)).toMatchObject({ enabled: true, auto: true, order: { claudeAgent: ["claude-c", "claude-b", "claude"] } });
    instance.trackTurn("thread-1", { generation: "g1", instanceId: "claude", requestMessageId: "m1", rerun: vi.fn(async () => undefined) });
    instance.markExhausted("claude", { resetsAt: at(HOUR), kind: "session" });
    expect(instance.nextAccount({ threadId: "thread-1", generation: "g1", stopReason: "usage_limit", ranOn: "claude", selection: SELECTION, accounts: ACCOUNTS }))
      .toMatchObject({ from: { instanceId: "claude" }, to: { instanceId: "claude-c" } });
    readings["claude-b"] = reading("claude-b", 0, 0);
    expect(instance.status(ACCOUNTS).order.claudeAgent).toEqual(["claude-b", "claude-c", "claude"]);
  });

  it("tells the app when new readings change the order it shows, and only then", () => {
    const readings: Record<string, PlanProviderRow> = {
      claude: reading("claude", 50, 50), "claude-b": reading("claude-b", 90, 20), "claude-c": reading("claude-c", 40, 10),
    };
    let config: AccountBatteryConfig = AUTO;
    const onChange = vi.fn();
    const instance = new AccountBattery({ config: () => config, now: () => NOW, usage: (id) => readings[id], onChange });
    instance.status(ACCOUNTS);
    instance.noteReadings(ACCOUNTS);
    expect(onChange).not.toHaveBeenCalled();
    readings.claude = reading("claude", 95, 95);
    instance.noteReadings(ACCOUNTS);
    expect(onChange).toHaveBeenCalledTimes(1);
    instance.status(ACCOUNTS);
    instance.noteReadings(ACCOUNTS);
    expect(onChange).toHaveBeenCalledTimes(1);
    config = { ...AUTO, auto: false };
    readings.claude = reading("claude", 0, 0);
    instance.noteReadings(ACCOUNTS);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("AccountBattery", () => {
  const battery = (options: Partial<ConstructorParameters<typeof AccountBattery>[0]> = {}) => {
    let now = NOW;
    const instance = new AccountBattery({ config: () => ON, now: () => now, ...options });
    return { instance, advance: (ms: number) => { now += ms; } };
  };

  it("rests an account until its reported reset, saves it privately and survives a restart", () => {
    const file = join(scratch(), "account-battery.json");
    const onChange = vi.fn();
    const { instance } = battery({ file, onChange });
    const resting = instance.markExhausted("claude-b", { resetsAt: at(2 * HOUR), kind: "session" });
    expect(resting).toEqual({ until: at(2 * HOUR), kind: "session", since: at(0) });
    expect(onChange).toHaveBeenCalledOnce();
    expect(instance.route(SELECTION, ACCOUNTS).instanceId).toBe("claude");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const restarted = new AccountBattery({ config: () => ON, file, now: () => NOW });
    expect(restarted.route(SELECTION, ACCOUNTS).instanceId).toBe("claude");
    expect(restarted.status(ACCOUNTS).resting).toEqual({ "claude-b": resting });
  });

  it("estimates five hours when nothing says, and asks the provider only while the battery is on", async () => {
    const planReset = vi.fn(async () => at(3 * HOUR));
    const { instance } = battery({ planReset });
    expect(instance.markExhausted("claude-b")).toEqual({ until: at(DEFAULT_REST_MS), estimated: true, since: at(0) });
    await vi.waitFor(() => expect(instance.status(ACCOUNTS).resting["claude-b"]).toEqual({ until: at(3 * HOUR), since: at(0) }));
    expect(planReset).toHaveBeenCalledWith("claude-b", undefined);
    const off = new AccountBattery({ config: () => ({ ...ON, enabled: false }), now: () => NOW, planReset });
    off.markExhausted("claude", { kind: "weekly" });
    expect(planReset).toHaveBeenCalledOnce();
    expect(instance.markExhausted("claude", { resetsAt: at(-HOUR) }).estimated).toBe(true);
  });

  it("ends a rest when the account finishes a turn begun since, when its reset passes, or when it is removed", () => {
    const { instance, advance } = battery();
    instance.markExhausted("claude-b", { resetsAt: at(HOUR) });
    expect(instance.recovered("claude-b", NOW - 1_000)).toBe(false);
    expect(instance.recovered("claude-b")).toBe(false);
    expect(instance.recovered("claude-b", NOW + 1_000)).toBe(true);
    expect(instance.recovered("claude-b", NOW + 1_000)).toBe(false);
    instance.markExhausted("claude-c");
    expect(instance.recovered("claude-c")).toBe(true);
    instance.markExhausted("claude-b", { resetsAt: at(HOUR) });
    const onB = { ...SELECTION, instanceId: "claude-b" };
    expect(instance.route(onB, ACCOUNTS).instanceId).toBe("claude");
    advance(HOUR + 1);
    expect(instance.route(onB, ACCOUNTS).instanceId).toBe("claude-b");
    expect(instance.status(ACCOUNTS).resting).toEqual({});
    instance.markExhausted("claude-c", { resetsAt: at(3 * HOUR) });
    instance.noteSwitch("thread-1", "claude-c", "claude");
    instance.forget("claude-c");
    expect(instance.status(ACCOUNTS).resting).toEqual({});
    expect(instance.takeBack("thread-1", "claude-c")).toBe(false);
  });

  it("shows a login's shared rest on every account signed in to it", () => {
    const twins = [account("claude", { email: "me@example.test" }), account("claude-b"), account("claude-c", { email: "me@example.test" })];
    const { instance } = battery();
    instance.markExhausted("claude", { resetsAt: at(HOUR) });
    expect(instance.status(twins)).toEqual({
      enabled: true,
      auto: false,
      sequence: ["claude-b", "claude", "claude-c"],
      order: { claudeAgent: ["claude-b", "claude", "claude-c"], codex: [] },
      resting: { claude: { until: at(HOUR), since: at(0) }, "claude-c": { until: at(HOUR), since: at(0), sharedWith: "claude" } },
      routed: {},
    });
  });

  it("offers one run on the next account for a turn that ran out of usage, and only for that turn", () => {
    const { instance } = battery();
    const rerun = vi.fn(async () => undefined);
    instance.trackTurn("thread-1", { generation: "g1", instanceId: "claude-b", requestMessageId: "m1", rerun });
    const ask = (overrides: Partial<Parameters<AccountBattery["nextAccount"]>[0]> = {}) => instance.nextAccount({
      threadId: "thread-1", generation: "g1", stopReason: "usage_limit", ranOn: "claude-b", selection: { ...SELECTION, instanceId: "claude-b" }, accounts: ACCOUNTS, ...overrides,
    });
    expect(ask()).toMatchObject({ from: { instanceId: "claude-b" }, to: { instanceId: "claude" }, rest: { estimated: true } });
    expect(ask({ selection: SELECTION })).toMatchObject({ from: { instanceId: "claude-b" }, to: { instanceId: "claude" } });
    instance.markExhausted("claude-b", { resetsAt: at(HOUR), kind: "session" });
    expect(ask()).toMatchObject({ from: { instanceId: "claude-b" }, to: { instanceId: "claude" }, rest: { until: at(HOUR), kind: "session" } });
    expect(ask({ stopReason: "end_turn" })).toBeNull();
    expect(ask({ generation: "g2" })).toBeNull();
    expect(ask({ selection: { instanceId: "codex", model: "gpt" } })).toBeNull();
    instance.markExhausted("claude", { resetsAt: at(HOUR) });
    instance.markExhausted("claude-c", { resetsAt: at(HOUR) });
    expect(ask()).toBeNull();
    expect(instance.recovered("claude", NOW + 1)).toBe(true);
    expect(ask()).toMatchObject({ to: { instanceId: "claude" } });
    expect(instance.keptTurn("thread-1", "g2")).toBeUndefined();
    expect(instance.keptTurn("thread-1", "g1")?.rerun).toBe(rerun);
    expect(instance.takeTurn("thread-1", "g2")).toBeUndefined();
    expect(instance.takeTurn("thread-1", "g1")?.rerun).toBe(rerun);
    expect(instance.takeTurn("thread-1", "g1")).toBeUndefined();
    expect(instance.keptTurn("thread-1", "g1")).toBeUndefined();
    expect(ask()).toBeNull();
    instance.trackTurn("thread-2", { generation: "g3", instanceId: "claude-b" });
    expect(ask({ threadId: "thread-2", generation: "g3" })).toBeNull();
  });

  it("tells when a conversation out of usage on every account it can use can run again", () => {
    const { instance, advance } = battery();
    expect(instance.readyAt(SELECTION, ACCOUNTS, "thread-1")).toBeUndefined();
    instance.markExhausted("claude", { resetsAt: at(3 * HOUR), kind: "session" });
    expect(instance.readyAt(SELECTION, ACCOUNTS, "thread-1")).toBeUndefined();
    instance.markExhausted("claude-b", { resetsAt: at(HOUR), kind: "session" });
    instance.markExhausted("claude-c", { resetsAt: at(2 * HOUR), kind: "session" });
    expect(instance.readyAt(SELECTION, ACCOUNTS, "thread-1")).toBe(at(HOUR));
    expect(instance.readyAt(SELECTION, [account("claude"), account("claude-b", { signedIn: false }), account("claude-c")])).toBe(at(2 * HOUR));
    const unusable = [account("claude"), account("claude-b", { models: ["claude-opus-5"] }), account("claude-c", { driverKind: "codex" })];
    expect(instance.readyAt(SELECTION, unusable)).toBe(at(2 * HOUR));
    expect(instance.readyAt(SELECTION, [account("claude", { eligible: false }), account("claude-b"), account("claude-c")])).toBe(at(3 * HOUR));
    expect(instance.readyAt({ ...SELECTION, instanceId: "gone" }, ACCOUNTS)).toBeUndefined();
    advance(HOUR);
    expect(instance.readyAt(SELECTION, ACCOUNTS, "thread-1")).toBeUndefined();
  });

  it("counts only the conversation's own account, and the one picked for it, while the battery is off", () => {
    const { instance } = battery({ config: () => ({ ...ON, enabled: false }) });
    instance.markExhausted("claude", { resetsAt: at(3 * HOUR) });
    instance.markExhausted("claude-b", { resetsAt: at(HOUR) });
    instance.markExhausted("claude-c", { resetsAt: at(2 * HOUR) });
    expect(instance.readyAt(SELECTION, ACCOUNTS, "thread-1")).toBe(at(3 * HOUR));
    instance.choose("thread-1", "claude", "claude-c", "claude");
    expect(instance.readyAt(SELECTION, ACCOUNTS, "thread-1")).toBe(at(2 * HOUR));
    expect(instance.readyAt(SELECTION, ACCOUNTS, "thread-2")).toBe(at(3 * HOUR));
    expect(instance.readyAt({ ...SELECTION, instanceId: "claude-b" }, ACCOUNTS, "thread-1")).toBe(at(HOUR));
  });

  it("says once that a conversation is back on the account it left first", () => {
    const file = join(scratch(), "account-battery.json");
    const instance = new AccountBattery({ config: () => ON, file, now: () => NOW });
    instance.noteSwitch("thread-1", "claude-b", "claude");
    instance.noteSwitch("thread-1", "claude", "claude-c");
    expect(instance.takeBack("thread-1", "claude")).toBe(false);
    expect(new AccountBattery({ config: () => ON, file, now: () => NOW }).takeBack("thread-1", "claude-b")).toBe(true);
    expect(instance.takeBack("thread-2", "claude-b")).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).away).toEqual({});
  });

  it("keeps a conversation on the account the person picked while the one that ran out rests", () => {
    const file = join(scratch(), "account-battery.json");
    const off = () => ({ ...ON, enabled: false });
    let now = NOW;
    const instance = new AccountBattery({ config: off, file, now: () => now });
    expect(instance.routes("thread-1")).toBe(false);
    instance.markExhausted("claude", { resetsAt: at(HOUR), kind: "session" });
    instance.choose("thread-1", "claude", "claude-c", "claude");
    expect(instance.routes("thread-1")).toBe(true);
    expect(instance.routes("thread-2")).toBe(false);
    expect(instance.routes()).toBe(false);
    expect(instance.route(SELECTION, ACCOUNTS, "thread-1")).toEqual({ ...SELECTION, instanceId: "claude-c" });
    expect(instance.route(SELECTION, ACCOUNTS, "thread-2")).toBe(SELECTION);
    expect(instance.route(SELECTION, ACCOUNTS)).toBe(SELECTION);
    expect(new AccountBattery({ config: off, file, now: () => now }).route(SELECTION, ACCOUNTS, "thread-1").instanceId).toBe("claude-c");
    const unusable = [
      [account("claude"), account("claude-c", { signedIn: false })],
      [account("claude"), account("claude-c", { enabled: false })],
      [account("claude"), account("claude-c", { eligible: false })],
      [account("claude"), account("claude-c", { models: ["claude-opus-5"] })],
      [account("claude", { eligible: false }), account("claude-c")],
      [account("claude")],
    ];
    for (const accounts of unusable) expect(instance.chosen("thread-1", SELECTION, accounts)).toBeUndefined();
    expect(instance.chosen("thread-1", { ...SELECTION, instanceId: "codex" }, [...ACCOUNTS, account("codex", { driverKind: "codex" })])).toBeUndefined();
    instance.markExhausted("claude-c", { resetsAt: at(HOUR) });
    expect(instance.route(SELECTION, ACCOUNTS, "thread-1")).toBe(SELECTION);
    expect(instance.recovered("claude-c", NOW + 1)).toBe(true);
    instance.choose("thread-1", "claude", "claude-b", "claude");
    expect(JSON.parse(readFileSync(file, "utf8")).away["thread-1"]).toMatchObject({ from: "claude", to: "claude-b", ranOut: "claude" });
    expect(instance.takeBack("thread-1", "claude-b")).toBe(false);
    now += HOUR + 1;
    expect(instance.route(SELECTION, ACCOUNTS, "thread-1")).toBe(SELECTION);
    expect(instance.takeBack("thread-1", "claude")).toBe(true);
    expect(instance.routes("thread-1")).toBe(false);
  });

  it("holds a pick over the battery's own choice until the account that ran out is back", () => {
    let now = NOW;
    const instance = new AccountBattery({ config: () => ON, now: () => now });
    const onB = { ...SELECTION, instanceId: "claude-b" };
    instance.markExhausted("claude-b", { resetsAt: at(HOUR) });
    expect(instance.route(onB, ACCOUNTS, "thread-1").instanceId).toBe("claude");
    instance.choose("thread-1", "claude-b", "claude-c", "claude-b");
    expect(instance.route(onB, ACCOUNTS, "thread-1").instanceId).toBe("claude-c");
    now += HOUR + 1;
    expect(instance.route(onB, ACCOUNTS, "thread-1").instanceId).toBe("claude-b");
    expect(instance.takeBack("thread-1", "claude-b")).toBe(true);
  });

  it("lets a new pick of an account that can take the turn win over an earlier move", () => {
    const instance = new AccountBattery({ config: () => ON, now: () => NOW });
    instance.markExhausted("claude", { resetsAt: at(HOUR) });
    instance.choose("thread-1", "claude", "claude-c", "claude");
    expect(instance.route(SELECTION, ACCOUNTS, "thread-1").instanceId).toBe("claude-c");
    const picked = { ...SELECTION, instanceId: "claude-b" };
    expect(instance.route(picked, ACCOUNTS, "thread-1")).toBe(picked);
  });

  it("drops a pick when either account in it is removed, and the whole move when the account it left is", () => {
    const off = () => ({ ...ON, enabled: false });
    const instance = new AccountBattery({ config: off, now: () => NOW });
    instance.markExhausted("claude", { resetsAt: at(HOUR) });
    instance.choose("thread-1", "claude", "claude-c", "claude");
    instance.forget("claude-c");
    expect(instance.routes("thread-1")).toBe(false);
    expect(instance.takeBack("thread-1", "claude")).toBe(true);
    instance.choose("thread-2", "claude", "claude-b", "claude");
    instance.forget("claude");
    expect(instance.routes("thread-2")).toBe(false);
    expect(instance.takeBack("thread-2", "claude")).toBe(false);
  });

  it("says once that a turn runs on another account while the picked one rests, then that it is back", () => {
    const file = join(scratch(), "account-battery.json");
    let now = NOW;
    const instance = new AccountBattery({ config: () => ON, file, now: () => now });
    instance.markExhausted("claude", { resetsAt: at(HOUR), kind: "session" });
    const ranOn = instance.route(SELECTION, ACCOUNTS, "thread-1").instanceId;
    expect(ranOn).toBe("claude-b");
    expect(instance.arrive("thread-1", SELECTION, ranOn, ACCOUNTS))
      .toMatch(/^Running on claude-b — claude is recharging, back (?:[A-Z][a-z]{2} \d{1,2} )?at \d{1,2}:\d\d [AP]M\.$/);
    expect(instance.arrive("thread-1", SELECTION, ranOn, ACCOUNTS)).toBeUndefined();
    expect(instance.status(ACCOUNTS).routed).toEqual({ "thread-1": { from: "claude", on: "claude-b" } });
    const restarted = new AccountBattery({ config: () => ON, file, now: () => now });
    expect(restarted.arrive("thread-1", SELECTION, "claude-b", ACCOUNTS)).toBeUndefined();
    expect(restarted.arrive("thread-1", SELECTION, "claude-c", ACCOUNTS)).toMatch(/^Running on claude-c — claude is recharging/);
    now += HOUR + 1;
    expect(restarted.status(ACCOUNTS).routed).toEqual({});
    expect(restarted.route(SELECTION, ACCOUNTS, "thread-1")).toBe(SELECTION);
    expect(restarted.arrive("thread-1", SELECTION, "claude", ACCOUNTS)).toBe("Back on claude.");
    expect(restarted.arrive("thread-1", SELECTION, "claude", ACCOUNTS)).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8")).away).toEqual({});
  });

  it("does not repeat a switch the conversation was already told about", () => {
    const instance = new AccountBattery({ config: () => ON, now: () => NOW });
    instance.markExhausted("claude", { resetsAt: at(HOUR) });
    instance.noteSwitch("thread-1", "claude", "claude-b");
    expect(instance.arrive("thread-1", SELECTION, "claude-b", ACCOUNTS)).toBeUndefined();
    instance.choose("thread-2", "claude", "claude-c", "claude");
    expect(instance.arrive("thread-2", SELECTION, "claude-c", ACCOUNTS)).toBeUndefined();
    expect(instance.arrive("thread-3", SELECTION, "claude", ACCOUNTS)).toBeUndefined();
    expect(instance.status(ACCOUNTS).routed).toEqual({ "thread-1": { from: "claude", on: "claude-b" }, "thread-2": { from: "claude", on: "claude-c" } });
    instance.noteSwitch("thread-1", "claude-b", "claude-c");
    expect(instance.arrive("thread-1", SELECTION, "claude-c", ACCOUNTS)).toBeUndefined();
    expect(instance.takeBack("thread-1", "claude")).toBe(true);
  });

  it("drops the move without a word when a switch lands back on the account it left", () => {
    const instance = new AccountBattery({ config: () => ON, now: () => NOW });
    instance.markExhausted("claude", { resetsAt: at(HOUR) });
    expect(instance.arrive("thread-1", SELECTION, "claude-b", ACCOUNTS)).toBeDefined();
    instance.noteSwitch("thread-1", "claude-b", "claude");
    expect(instance.arrive("thread-1", SELECTION, "claude", ACCOUNTS)).toBeUndefined();
    expect(instance.status(ACCOUNTS).routed).toEqual({});
  });

  it("names why the picked account was passed over", () => {
    const instance = new AccountBattery({ config: () => ON, now: () => NOW });
    const signedOut = [account("claude", { signedIn: false }), account("claude-b")];
    const off = [account("claude", { enabled: false }), account("claude-b")];
    expect(instance.arrive("thread-1", SELECTION, "claude-b", signedOut)).toBe("Running on claude-b — claude isn't signed in.");
    expect(instance.arrive("thread-2", SELECTION, "claude-b", off)).toBe("Running on claude-b — claude is turned off.");
    expect(instance.status(off).routed).toEqual({ "thread-1": { from: "claude", on: "claude-b" }, "thread-2": { from: "claude", on: "claude-b" } });
    expect(instance.arrive("thread-3", SELECTION, "claude-b", ACCOUNTS)).toBe("Running on claude-b instead of claude.");
    expect(instance.status(ACCOUNTS).routed).toEqual({});
  });

  it("forgets where a conversation runs when that account is removed, still owing the move back", () => {
    const instance = new AccountBattery({ config: () => ON, now: () => NOW });
    instance.markExhausted("claude", { resetsAt: at(HOUR) });
    instance.arrive("thread-1", SELECTION, "claude-b", ACCOUNTS);
    instance.forget("claude-b");
    expect(instance.status(ACCOUNTS).routed).toEqual({});
    expect(instance.arrive("thread-1", SELECTION, "claude-c", ACCOUNTS)).toMatch(/^Running on claude-c/);
    expect(instance.takeBack("thread-1", "claude")).toBe(true);
  });

  it("stops showing a move once a new pick takes the turn itself", () => {
    const instance = new AccountBattery({ config: () => ON, now: () => NOW });
    instance.markExhausted("claude", { resetsAt: at(HOUR) });
    instance.arrive("thread-1", SELECTION, "claude-b", ACCOUNTS);
    const picked = { ...SELECTION, instanceId: "claude-c" };
    expect(instance.arrive("thread-1", picked, "claude-c", ACCOUNTS)).toBeUndefined();
    expect(instance.status(ACCOUNTS).routed).toEqual({});
    expect(instance.takeBack("thread-1", "claude")).toBe(true);
  });

  it("starts empty from a missing or damaged file", () => {
    const dir = scratch();
    expect(new AccountBattery({ config: () => ON, file: join(dir, "missing.json") }).status(ACCOUNTS).resting).toEqual({});
    expect(existsSync(join(dir, "missing.json"))).toBe(false);
  });
});

describe("words and times", () => {
  it("says where the conversation went and until when the other account rests", () => {
    const notice = (resting: Rest | undefined) => switchNotice({ to: "Work", from: "Personal", rest: resting, now: NOW, timeZone: "America/Los_Angeles" });
    expect(notice(rest(Date.parse("2026-10-07T22:00:00Z") - NOW, { kind: "session" })))
      .toBe("Switched to Work — Personal hit its 5-hour limit, resets at 3:00 PM.");
    const weekly = { until: "2026-10-10T00:00:00.000Z", since: at(0) };
    expect(notice({ ...weekly, kind: "weekly" })).toBe("Switched to Work — Personal hit its weekly limit, resets Oct 9 at 5:00 PM.");
    expect(notice({ ...weekly, kind: "opus", estimated: true })).toBe("Switched to Work — Personal hit its Opus limit.");
    expect(notice(weekly)).toBe("Switched to Work — Personal is out of usage until Oct 9, 5:00 PM.");
    expect(notice({ ...weekly, kind: "constructor" })).toBe("Switched to Work — Personal is out of usage until Oct 9, 5:00 PM.");
    expect(notice({ ...weekly, estimated: true })).toBe("Switched to Work — Personal is out of usage for now.");
    expect(notice(undefined)).toBe("Switched to Work — Personal is out of usage for now.");
    expect(backNotice("Personal")).toBe("Back on Personal.");
    const running = (resting: Rest | undefined, why?: "signedOut" | "off") =>
      routedNotice({ to: "Work", from: "Personal", rest: resting, why, now: NOW, timeZone: "America/Los_Angeles" });
    expect(running({ until: "2026-10-07T22:30:00.000Z", since: at(0) })).toBe("Running on Work — Personal is recharging, back at 3:30 PM.");
    expect(running({ ...weekly })).toBe("Running on Work — Personal is recharging, back Oct 9 at 5:00 PM.");
    expect(running({ until: "2026-10-07T22:30:00.000Z", since: at(0), estimated: true })).toBe("Running on Work — Personal is recharging, back around 3:30 PM.");
    expect(running({ until: at(-1), since: at(0) }, "signedOut")).toBe("Running on Work — Personal isn't signed in.");
    expect(running(undefined, "off")).toBe("Running on Work — Personal is turned off.");
    expect(running(undefined)).toBe("Running on Work instead of Personal.");
    expect(resetLabel("2026-10-07T22:00:00.000Z", NOW, "UTC")).toBe("10:00 PM");
  });

  it("reads the reset of the limit that was hit from a usage reading", () => {
    const window = (usedPercent: number, resetsAt: string | null) => ({ available: true, usedPercent, remainingPercent: 100 - usedPercent, resetsAt });
    const row: PlanProviderRow = {
      id: "claude", name: "Claude", driver: "claude", plan: "Max", ok: true, error: null,
      fiveHour: window(100, at(2 * HOUR)), weekly: window(40, at(72 * HOUR)), extra: [],
      models: [{ name: "Opus", windows: [{ label: "Weekly", usedPercent: 100, remainingPercent: 0, resetsAt: at(48 * HOUR) }] }],
    };
    expect(planResetAt(row, "session", NOW)).toBe(at(2 * HOUR));
    expect(planResetAt(row, "weekly", NOW)).toBe(at(72 * HOUR));
    expect(planResetAt(row, "opus", NOW)).toBe(at(48 * HOUR));
    expect(planResetAt(row, undefined, NOW)).toBe(at(48 * HOUR));
    expect(planResetAt({ ...row, ok: false }, "session", NOW)).toBeUndefined();
    expect(planResetAt({ ...row, fiveHour: window(20, at(HOUR)), models: [] }, undefined, NOW)).toBeUndefined();
  });
});

describe("the row a switch notice replaces", () => {
  const row = (id: string, role: string, kind: string, tool?: { name: string; ok: boolean }) => ({ id, role, kind, ...(tool ? { tool } : {}) });
  const limit = (id: string) => row(id, "bot", "activity", { name: "error: You've hit your session limit · resets 4am (UTC)", ok: false });

  it("is the failed row the request's attempt left, not an older one", () => {
    const path = [row("q0", "user", "text"), limit("old"), row("q1", "user", "text"), row("t", "bot", "activity", { name: "Bash", ok: true }), limit("new")];
    expect(limitRowToReplace(path, "q1")?.id).toBe("new");
  });

  it("is nothing when the request is gone or left no failed row", () => {
    const path = [row("q0", "user", "text"), limit("old"), row("q1", "user", "text"), row("r", "bot", "activity", { name: "recovery: Back on Claude account 1.", ok: true })];
    expect(limitRowToReplace(path, "q1")).toBeNull();
    expect(limitRowToReplace(path, "missing")).toBeNull();
    expect(limitRowToReplace(path, undefined)).toBeNull();
  });
});


describe("automatic continuation defaults and cross-provider order", () => {
  const codex = account("codex", { driverKind: "codex", models: ["gpt-5.5"], defaultModel: "gpt-5.5", email: "same@example.test" });
  const accounts = [account("claude", { email: "same@example.test" }), codex];
  it("defaults on for two eligible accounts, including different providers, while explicit off wins", () => {
    expect(batteryEnabled(undefined, accounts)).toBe(true);
    expect(batteryEnabled(undefined, accounts.slice(0, 1))).toBe(false);
    expect(batteryEnabled(undefined, [accounts[0]!, { ...codex, eligible: false }])).toBe(false);
    expect(batteryEnabled({ ...ON, enabled: false }, accounts)).toBe(false);
    const battery = new AccountBattery({ config: () => undefined, accounts: () => accounts, now: () => NOW });
    expect(battery.enabled).toBe(true);
    expect(battery.status(accounts).enabled).toBe(true);
    battery.markExhausted("claude", { resetsAt: at(HOUR) });
    expect(battery.route(SELECTION, accounts)).toEqual({ instanceId: "codex", model: "gpt-5.5" });
    expect(battery.status(accounts).resting.codex).toBeUndefined();
  });

  it("validates and preserves a saved sequence across providers", () => {
    const config = { ...ON, sequence: ["codex", "claude"] };
    expect(batterySequence({ config, accounts, resting: {}, now: NOW })).toEqual(["codex", "claude"]);
    expect(checkBatteryConfig({ sequence: ["codex", "codex", "claude"] }, accounts, ON))
      .toMatchObject({ ok: true, config: { sequence: ["codex", "claude"] } });
    expect(checkBatteryConfig({ sequence: ["missing"] }, accounts, ON).ok).toBe(false);
    expect(withoutAccount(config, "codex")?.sequence).toEqual(["claude"]);
  });
});


describe("keeping going across engines", () => {
  const codex = (instanceId: string, extra: Partial<BatteryAccount> = {}) =>
    account(instanceId, { driverKind: "codex", models: ["gpt-5.5", "gpt-5.5-mini"], defaultModel: "gpt-5.5", ...extra });
  const accounts = [account("claude"), account("claude-b"), codex("chatgpt")];
  const config: AccountBatteryConfig = { enabled: true, order: { claudeAgent: ["claude", "claude-b"], codex: ["chatgpt"] } };
  const dog = { instanceId: "claude", model: "claude-opus-5", effort: "high" as const };

  it("names the two engines the way a person would", () => {
    expect(engineName("claudeAgent")).toBe("Claude");
    expect(engineName("codex")).toBe("Codex");
    expect(engineName("grokAgent")).toBe("grokAgent");
  });

  it("says in one short line that Claude is recharging and the work continues on Codex, only when the engine really changes", () => {
    expect(crossEngineNotice(accounts[0], accounts[2], "Continuing")).toBe("Claude is recharging. Continuing on Codex.");
    expect(crossEngineNotice(accounts[2], accounts[0], "Running")).toBe("Codex is recharging. Running on Claude.");
    expect(crossEngineNotice(accounts[0], accounts[1], "Continuing")).toBeUndefined();
    expect(crossEngineNotice(undefined, accounts[1], "Continuing")).toBeUndefined();
  });

  it("goes through the whole order: with every Claude account recharging, the work moves to Codex on its default model and drops Claude-only settings", () => {
    const resting = { claude: rest(HOUR), "claude-b": rest(HOUR) };
    expect(routeSelection({ config, selection: dog, accounts, resting, now: NOW })).toEqual({ instanceId: "chatgpt", model: "gpt-5.5" });
  });

  it("uses the model the dog chose for that engine, matched by account or by engine, and falls back to the default", () => {
    const resting = { claude: rest(HOUR), "claude-b": rest(HOUR) };
    const choice = [{ instanceId: "chatgpt", model: "gpt-5.5-mini" }];
    expect(routeSelection({ config, selection: dog, accounts, resting, now: NOW, preferred: choice })).toEqual({ instanceId: "chatgpt", model: "gpt-5.5-mini" });
    expect(routeSelection({ config, selection: dog, accounts, resting, now: NOW, preferred: [{ instanceId: "chatgpt", model: "gpt-unknown" }] }))
      .toEqual({ instanceId: "chatgpt", model: "gpt-5.5" });
    const second = [...accounts, codex("chatgpt-b")];
    expect(chosenModelOn(second[3]!, second, choice)).toBe("gpt-5.5-mini");
    expect(chosenModelOn(second[1]!, second, choice)).toBeUndefined();
    expect(selectionOnAccount(dog, accounts[1]!, accounts, choice)).toEqual({ ...dog, instanceId: "claude-b" });
  });

  it("checks a model-specific rest against the model it will actually run", () => {
    const codexOnly = [account("claude"), codex("chatgpt")];
    const resting = { claude: rest(HOUR), chatgpt: rest(HOUR, { kind: "opus" }) };
    expect(routeSelection({ config, selection: dog, accounts: codexOnly, resting, now: NOW }))
      .toEqual({ instanceId: "chatgpt", model: "gpt-5.5" });
  });

  it("stays put when the switch is off, and when every account in the order is out", () => {
    const resting = { claude: rest(HOUR), "claude-b": rest(HOUR) };
    expect(routeSelection({ config: { ...config, enabled: false }, selection: dog, accounts, resting, now: NOW })).toBe(dog);
    expect(routeSelection({ config, selection: dog, accounts, resting: { ...resting, chatgpt: rest(HOUR) }, now: NOW })).toBe(dog);
  });

  it("asks the battery for the dog's chosen model on every path that routes", () => {
    const choice = [{ instanceId: "chatgpt", model: "gpt-5.5-mini" }];
    const preferred = vi.fn((threadId: string | undefined) => threadId === "thread-1" ? choice : undefined);
    const battery = new AccountBattery({ config: () => config, accounts: () => accounts, now: () => NOW, preferred });
    battery.markExhausted("claude", { resetsAt: at(HOUR) });
    battery.markExhausted("claude-b", { resetsAt: at(HOUR) });
    expect(battery.route(dog, accounts, "thread-1")).toEqual({ instanceId: "chatgpt", model: "gpt-5.5-mini" });
    expect(battery.route(dog, accounts, "thread-2")).toEqual({ instanceId: "chatgpt", model: "gpt-5.5" });
    expect(battery.route(dog, accounts)).toEqual({ instanceId: "chatgpt", model: "gpt-5.5" });
    const turn = { generation: "g", instanceId: "claude", rerun: async () => undefined };
    battery.trackTurn("thread-1", turn);
    expect(battery.nextAccount({ threadId: "thread-1", generation: "g", stopReason: "usage_limit", ranOn: "claude", selection: dog, accounts }))
      .toMatchObject({ to: { instanceId: "chatgpt" } });
    expect(battery.arrive("thread-1", dog, "chatgpt", accounts)).toBe("Claude is recharging. Running on Codex.");
    expect(battery.arrive("thread-1", dog, "chatgpt", accounts)).toBeUndefined();
  });
});
