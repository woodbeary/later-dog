import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanProviderRow } from "../plan-usage.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import {
  AccountBattery, DEFAULT_REST_MS, backNotice, batteryOrder, checkBatteryConfig, limitRowToReplace, planResetAt, resetLabel, routeSelection, switchNotice, withoutAccount,
  type AccountBatteryConfig, type BatteryAccount, type Rest,
} from "./account-battery.ts";

// Wednesday 7 October 2026, 11:30 AM in Los Angeles.
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

  it("runs on the favourite, keeping the model, effort and variant", () => {
    expect(route()).toEqual({ ...SELECTION, instanceId: "claude-b" });
    expect(route({ selection: { instanceId: "claude-c", model: "claude-opus-5", variant: "fast" } }))
      .toEqual({ instanceId: "claude-b", model: "claude-opus-5", variant: "fast" });
  });

  it("passes over a resting, disabled, signed-out or model-less account to the next one up", () => {
    expect(route({ resting: { "claude-b": rest(HOUR) } })).toEqual({ ...SELECTION, instanceId: "claude" });
    expect(route({ resting: { "claude-b": rest(HOUR), claude: rest(2 * HOUR) } })).toEqual({ ...SELECTION, instanceId: "claude-c" });
    expect(route({ accounts: [account("claude"), account("claude-b", { enabled: false }), account("claude-c")] }).instanceId).toBe("claude");
    expect(route({ accounts: [account("claude"), account("claude-b", { signedIn: false }), account("claude-c")] }).instanceId).toBe("claude");
    expect(route({ accounts: [account("claude"), account("claude-b", { models: ["claude-opus-5"] }), account("claude-c")] }).instanceId).toBe("claude");
    // not read yet: only what is known stops a pick
    expect(route({ accounts: [account("claude"), account("claude-b", { signedIn: undefined }), account("claude-c")] }).instanceId).toBe("claude-b");
    // a custom id no account lists runs wherever the engine runs
    expect(route({ selection: { ...SELECTION, model: "claude-custom-fixture" } }).instanceId).toBe("claude-b");
  });

  it("comes back to the favourite once its limit has reset, and keeps the conversation's own when every account rests", () => {
    expect(route({ resting: { "claude-b": rest(-1) } }).instanceId).toBe("claude-b");
    expect(route({ resting: { "claude-b": rest(HOUR), claude: rest(HOUR), "claude-c": rest(HOUR) } })).toBe(SELECTION);
  });

  it("stops only that model family for an Opus or Sonnet limit", () => {
    const opus = { "claude-b": rest(HOUR, { kind: "opus" }) };
    expect(route({ resting: opus }).instanceId).toBe("claude-b");
    expect(route({ resting: opus, selection: { ...SELECTION, model: "claude-opus-5" } }).instanceId).toBe("claude");
  });

  it("rests accounts signed in to the same login together", () => {
    const twins = [account("claude", { email: "me@example.test" }), account("claude-b", { email: "work@example.test" }), account("claude-c", { email: "ME@example.test" })];
    const resting = { claude: rest(HOUR) };
    expect(route({ accounts: twins, resting, config: { enabled: true, order: { claudeAgent: ["claude", "claude-c", "claude-b"] } } }).instanceId).toBe("claude-b");
  });

  it("keeps a Codex conversation on Codex accounts, in Codex's own order", () => {
    const codex = (instanceId: string) => account(instanceId, { driverKind: "codex", models: ["gpt-5.5-codex"] });
    const accounts = [...ACCOUNTS, codex("chatgpt"), codex("chatgpt-b")];
    const config = { enabled: true, order: { ...ON.order, codex: ["chatgpt-b", "chatgpt"] } };
    const selection = { instanceId: "chatgpt", model: "gpt-5.5-codex" };
    expect(route({ config, accounts, selection })).toEqual({ ...selection, instanceId: "chatgpt-b" });
    // the Codex favourite resting sends the turn to the next Codex account, never to a Claude one
    expect(route({ config, accounts, selection, resting: { "chatgpt-b": rest(HOUR) } })).toEqual(selection);
    expect(route({ config, accounts, selection, resting: { "chatgpt-b": rest(HOUR), chatgpt: rest(HOUR) } })).toEqual(selection);
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
    expect(withoutAccount(ON, "elsewhere")).toBeUndefined();
    expect(withoutAccount(undefined, "claude")).toBeUndefined();
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
    // a garbled or past reset is no reset
    expect(instance.markExhausted("claude", { resetsAt: at(-HOUR) }).estimated).toBe(true);
  });

  it("ends a rest when the account finishes a turn begun since, when its reset passes, or when it is removed", () => {
    const { instance, advance } = battery();
    instance.markExhausted("claude-b", { resetsAt: at(HOUR) });
    // another conversation's turn, already running when the limit came in
    expect(instance.recovered("claude-b", NOW - 1_000)).toBe(false);
    // a finished turn of unknown start ends only a guessed rest
    expect(instance.recovered("claude-b")).toBe(false);
    expect(instance.recovered("claude-b", NOW + 1_000)).toBe(true);
    expect(instance.recovered("claude-b", NOW + 1_000)).toBe(false);
    instance.markExhausted("claude-c");
    expect(instance.recovered("claude-c")).toBe(true);
    instance.markExhausted("claude-b", { resetsAt: at(HOUR) });
    advance(HOUR + 1);
    expect(instance.route(SELECTION, ACCOUNTS).instanceId).toBe("claude-b");
    expect(instance.status(ACCOUNTS).resting).toEqual({});
    instance.markExhausted("claude-c", { resetsAt: at(3 * HOUR) });
    instance.noteSwitch("thread-1", "claude-c");
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
      order: { claudeAgent: ["claude-b", "claude", "claude-c"], codex: [] },
      resting: { claude: { until: at(HOUR), since: at(0) }, "claude-c": { until: at(HOUR), since: at(0), sharedWith: "claude" } },
    });
  });

  it("offers one run on the next account for a turn that ran out of usage, and only for that turn", () => {
    const { instance } = battery();
    const rerun = vi.fn(async () => undefined);
    instance.trackTurn("thread-1", { generation: "g1", instanceId: "claude-b", requestMessageId: "m1", rerun });
    const ask = (overrides: Partial<Parameters<AccountBattery["nextAccount"]>[0]> = {}) => instance.nextAccount({
      threadId: "thread-1", generation: "g1", stopReason: "usage_limit", ranOn: "claude-b", selection: SELECTION, accounts: ACCOUNTS, ...overrides,
    });
    // not resting yet: the favourite would take it again
    expect(ask()).toBeNull();
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
    expect(instance.takeTurn("thread-1", "g2")).toBeUndefined();
    expect(instance.takeTurn("thread-1", "g1")?.rerun).toBe(rerun);
    expect(instance.takeTurn("thread-1", "g1")).toBeUndefined();
    expect(ask()).toBeNull();
    // a turn kept without a re-run (a backup run, a routine) never gets one
    instance.trackTurn("thread-2", { generation: "g3", instanceId: "claude-b" });
    expect(ask({ threadId: "thread-2", generation: "g3" })).toBeNull();
  });

  it("says once that a conversation is back on the account it left first", () => {
    const file = join(scratch(), "account-battery.json");
    const instance = new AccountBattery({ config: () => ON, file, now: () => NOW });
    instance.noteSwitch("thread-1", "claude-b");
    instance.noteSwitch("thread-1", "claude");
    expect(instance.takeBack("thread-1", "claude")).toBe(false);
    expect(new AccountBattery({ config: () => ON, file, now: () => NOW }).takeBack("thread-1", "claude-b")).toBe(true);
    expect(instance.takeBack("thread-2", "claude-b")).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).away).toEqual({});
  });

  it("starts empty from a missing or damaged file", () => {
    const dir = scratch();
    expect(new AccountBattery({ config: () => ON, file: join(dir, "missing.json") }).status(ACCOUNTS).resting).toEqual({});
    expect(existsSync(join(dir, "missing.json"))).toBe(false);
  });
});

describe("words and times", () => {
  it("says where the conversation went and until when the other account rests", () => {
    const resting = rest(Date.parse("2026-10-07T22:00:00Z") - NOW, { kind: "session" });
    expect(switchNotice({ to: "Work", from: "Personal", rest: resting, now: NOW, timeZone: "America/Los_Angeles" }))
      .toBe("Switched to Work — Personal is out of usage until 3:00 PM.");
    const weekly = { until: "2026-10-10T00:00:00.000Z", since: at(0) };
    expect(switchNotice({ to: "Work", from: "Personal", rest: weekly, now: NOW, timeZone: "America/Los_Angeles" }))
      .toBe("Switched to Work — Personal is out of usage until Oct 9, 5:00 PM.");
    expect(switchNotice({ to: "Work", from: "Personal", rest: { ...weekly, estimated: true }, now: NOW }))
      .toBe("Switched to Work — Personal is out of usage for now.");
    expect(backNotice("Personal")).toBe("Back on Personal.");
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
