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

  it("keeps a Codex conversation on Codex accounts, in Codex's own order", () => {
    const codex = (instanceId: string) => account(instanceId, { driverKind: "codex", models: ["gpt-5.5-codex"] });
    const accounts = [...ACCOUNTS, codex("chatgpt"), codex("chatgpt-b")];
    const config = { enabled: true, order: { ...ON.order, codex: ["chatgpt-b", "chatgpt"] } };
    const selection = { instanceId: "chatgpt", model: "gpt-5.5-codex" };
    expect(route({ config, accounts, selection })).toBe(selection);
    expect(route({ config, accounts, selection, resting: { chatgpt: rest(HOUR) } })).toEqual({ ...selection, instanceId: "chatgpt-b" });
    expect(route({ config, accounts, selection, resting: { "chatgpt-b": rest(HOUR), chatgpt: rest(HOUR) } })).toBe(selection);
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
    const onB = { ...SELECTION, instanceId: "claude-b" };
    expect(instance.route(onB, ACCOUNTS).instanceId).toBe("claude");
    advance(HOUR + 1);
    expect(instance.route(onB, ACCOUNTS).instanceId).toBe("claude-b");
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
      threadId: "thread-1", generation: "g1", stopReason: "usage_limit", ranOn: "claude-b", selection: { ...SELECTION, instanceId: "claude-b" }, accounts: ACCOUNTS, ...overrides,
    });
    expect(ask()).toBeNull();
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
    // a turn kept without a re-run (a backup run, a routine) never gets one
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
    expect(instance.readyAt(SELECTION, unusable)).toBe(at(3 * HOUR));
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
    instance.noteSwitch("thread-1", "claude-b");
    instance.noteSwitch("thread-1", "claude");
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
      [account("claude"), account("claude-c", { driverKind: "codex" })],
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
