import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instanceConfigs, type AppConfig } from "../config.ts";
import { clearPlanUsageCache, fileCredentialReader, loadPlanUsage, parseClaudeUsage, planAccountsFromInstances, type PlanProviderRow, type PlanResponse } from "../plan-usage.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { AccountBattery, switchNotice, type AccountBatteryConfig, type BatteryAccount, type Rest } from "./account-battery.ts";
import { accountUsage, accountUsageText, withAccountLimits } from "./account-usage.ts";
import { accountRunsNow } from "./chat-account-runs.ts";

const NOW = Date.parse("2026-11-14T18:49:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const SESSION_RESET = "2026-11-14T23:49:00.000Z";
const WEEK_RESET = "2026-11-16T16:59:30.000Z";
const MONDAY_NINE = "2026-11-16T17:00:00.000Z";
const FABLE = "claude-fable-5-1";
const OPUS = "claude-opus-5-5";

const claude = (instanceId: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true,
  models: [FABLE, OPUS], defaultModel: FABLE, ...extra,
});
const ACCOUNTS = [claude("daniel"), claude("anthony")];
const CONFIG: AccountBatteryConfig = { enabled: true, auto: true, order: { claudeAgent: ["daniel", "anthony"] } };

const window = (usedPercent: number, resetsAt: string) => ({ available: true, usedPercent, remainingPercent: 100 - usedPercent, resetsAt });
const fableWeek = (usedPercent: number, resetsAt = WEEK_RESET) => ({ name: "Fable", windows: [{ label: "Weekly", usedPercent, remainingPercent: 100 - usedPercent, resetsAt }] });
const reading = (id: string, fiveHour: number, weekly: number, extra: Partial<PlanProviderRow> = {}): PlanProviderRow => ({
  id, name: id, driver: "claude", plan: "max", ok: true, error: null,
  fiveHour: window(fiveHour, SESSION_RESET), weekly: window(weekly, WEEK_RESET), extra: [], models: [], ...extra,
});

function home(readings: Record<string, PlanProviderRow | undefined>, options: { file?: string; readAt?: () => number } = {}) {
  let now = NOW;
  const battery = new AccountBattery({
    config: () => CONFIG, accounts: () => ACCOUNTS, now: () => now, usage: (id) => readings[id],
    usageAt: options.readAt ?? (() => now), ...(options.file ? { file: options.file } : {}),
  });
  return { battery, readings, advance: (ms: number) => { now += ms; }, now: () => now };
}

const on = (instanceId: string, model: string) => ({ instanceId, model });

const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "laterdog-limits-")); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
beforeEach(() => clearPlanUsageCache());

describe("one model's own limit", () => {
  it("stops only that model on the account, so other models and other dogs keep using it", () => {
    const { battery } = home({ daniel: reading("daniel", 0, 69), anthony: reading("anthony", 10, 40) });
    battery.markExhausted("daniel", { resetsAt: MONDAY_NINE, kind: "seven_day_overage_included" }, FABLE);
    expect(battery.route(on("daniel", OPUS), ACCOUNTS, "opus-dog")).toEqual(on("daniel", OPUS));
    expect(battery.route(on("daniel", FABLE), ACCOUNTS, "fable-dog")).toEqual(on("anthony", FABLE));
    expect(battery.status(ACCOUNTS).resting).toEqual({});
    expect(battery.restingUntil("daniel", ACCOUNTS, OPUS)).toBeUndefined();
    expect(battery.restingUntil("daniel", ACCOUNTS, `${FABLE}[1m]`)).toBe(MONDAY_NINE);
    expect(battery.limitsOf(claude("daniel"), ACCOUNTS)).toEqual([expect.objectContaining({ model: "Fable", until: MONDAY_NINE })]);
  });

  it("names the model that ran when the engine reports the shared per-model allowance", () => {
    const { battery } = home({});
    expect(battery.markExhausted("daniel", { resetsAt: MONDAY_NINE, kind: "seven_day_overage_included" }, OPUS).model).toBe("Opus");
    expect(battery.markExhausted("anthony", { kind: "fable" }, OPUS).model).toBe("Fable");
    expect(battery.markExhausted("anthony", { resetsAt: at(HOUR), kind: "session" }, FABLE).model).toBeUndefined();
  });

  it("keeps both when two models on one account each hit their own limit, and only a turn on that model ends its rest", () => {
    const { battery } = home({});
    battery.markExhausted("daniel", { resetsAt: MONDAY_NINE, kind: "fable" }, FABLE);
    battery.markExhausted("daniel", { resetsAt: at(30 * HOUR), kind: "opus" }, OPUS);
    expect(battery.restOf(claude("daniel"), ACCOUNTS, FABLE)?.model).toBe("Fable");
    expect(battery.restOf(claude("daniel"), ACCOUNTS, OPUS)?.model).toBe("Opus");
    expect(battery.recovered("daniel", NOW + MINUTE, "claude-sonnet-5-5")).toBe(false);
    expect(battery.recovered("daniel", NOW + MINUTE, OPUS)).toBe(true);
    expect(battery.restOf(claude("daniel"), ACCOUNTS, OPUS)).toBeUndefined();
    expect(battery.restOf(claude("daniel"), ACCOUNTS, FABLE)?.model).toBe("Fable");
  });

  it("revives a dog on another model of that account, never one on the model that waits", () => {
    const { battery } = home({});
    battery.markExhausted("daniel", { resetsAt: MONDAY_NINE, kind: "fable" }, FABLE);
    const chat = (model: string) => ({
      turn: undefined, dog: on("daniel", model), route: (selection: { instanceId: string; model: string }) => selection, accounts: ACCOUNTS,
      resting: (account: BatteryAccount, running: string) => Boolean(battery.restOf(account, ACCOUNTS, running)),
    });
    expect(accountRunsNow(chat(OPUS))).toBe(true);
    expect(accountRunsNow(chat(FABLE))).toBe(false);
  });

  it("reads one model's weekly window from the usage reply and rests that model from the reading alone", () => {
    const parsed = parseClaudeUsage({
      five_hour: { utilization: 0, resets_at: SESSION_RESET },
      seven_day: { utilization: 69, resets_at: WEEK_RESET },
      limits: [
        { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 100, resets_at: Date.parse(WEEK_RESET) / 1000 },
        { kind: "something_else", scope: { model: { display_name: "Haiku" } }, percent: 100, resets_at: WEEK_RESET },
      ],
    });
    expect(parsed.models).toEqual([fableWeek(100)]);
    const { battery } = home({ daniel: reading("daniel", 0, 69, { models: parsed.models }), anthony: reading("anthony", 10, 40) });
    expect(battery.route(on("daniel", FABLE), ACCOUNTS, "fable-dog").instanceId).toBe("anthony");
    expect(battery.route(on("daniel", OPUS), ACCOUNTS, "opus-dog").instanceId).toBe("daniel");
    expect(battery.status(ACCOUNTS).resting).toEqual({});
    expect(battery.limitsOf(claude("daniel"), ACCOUNTS)).toEqual([{ until: WEEK_RESET, kind: "weekly", model: "Fable", since: at(0) }]);
  });

  it("frees the account a saved rest from before this change held whole, keeping only its model waiting", () => {
    const file = join(scratch(), "account-battery.json");
    writeFileSync(file, JSON.stringify({ version: 1, resting: {
      daniel: { until: MONDAY_NINE, kind: "seven_day_overage_included", since: at(0) },
      anthony: { until: at(3 * HOUR), kind: "opus", since: at(0) },
    } }));
    const { battery } = home({}, { file });
    expect(battery.status(ACCOUNTS).resting).toEqual({});
    expect(battery.restOf(claude("daniel"), ACCOUNTS, OPUS)).toBeUndefined();
    expect(battery.restOf(claude("daniel"), ACCOUNTS, FABLE)).toMatchObject({ until: MONDAY_NINE, model: "Fable" });
    expect(battery.restOf(claude("anthony"), ACCOUNTS, OPUS)).toMatchObject({ until: at(3 * HOUR), model: "Opus" });
  });

  it("says the model in the switch notice", () => {
    const rest: Rest = { until: MONDAY_NINE, kind: "seven_day_overage_included", model: "Fable", since: at(0) };
    expect(switchNotice({ to: "anthony", from: "daniel", rest, now: NOW, timeZone: "America/Los_Angeles" }))
      .toBe("Switched to anthony — daniel hit its Fable limit, resets Nov 16 at 9:00 AM.");
  });
});

describe("a rest never outlives the limit it is based on", () => {
  it("ends when a fresh reading shows room in the model's own window, and holds while the reading still agrees", () => {
    const { battery, readings, advance } = home({ daniel: reading("daniel", 0, 69, { models: [fableWeek(100)] }), anthony: reading("anthony", 10, 40) });
    battery.markExhausted("daniel", { resetsAt: MONDAY_NINE, kind: "fable" }, FABLE);
    advance(MINUTE);
    readings.daniel = reading("daniel", 0, 70, { models: [fableWeek(100)] });
    expect(battery.route(on("daniel", FABLE), ACCOUNTS, "fable-dog").instanceId).toBe("anthony");
    readings.daniel = reading("daniel", 0, 70, { models: [fableWeek(12, "2026-11-23T16:59:30.000Z")] });
    expect(battery.route(on("daniel", FABLE), ACCOUNTS, "fable-dog").instanceId).toBe("daniel");
    expect(battery.limitsOf(claude("daniel"), ACCOUNTS)).toEqual([]);
  });

  it("ends a limit the engine left unnamed once a fresh reading shows room in both windows, never on a reading that agrees", () => {
    const { battery, readings, advance } = home({ daniel: reading("daniel", 0, 69), anthony: reading("anthony", 10, 40) });
    battery.markExhausted("daniel", { resetsAt: MONDAY_NINE });
    advance(MINUTE);
    expect(battery.route(on("daniel", OPUS), ACCOUNTS, "dog").instanceId).toBe("anthony");
    readings.daniel = reading("daniel", 3, 70);
    expect(battery.route(on("daniel", OPUS), ACCOUNTS, "dog").instanceId).toBe("daniel");
  });

  it("ends no later than the reset the reading gives for that window, and ignores a reading of a window that ended before the limit", () => {
    const earlier = "2026-11-15T17:00:00.000Z";
    const { battery, readings, advance } = home({ daniel: reading("daniel", 0, 100, { weekly: window(100, earlier) }), anthony: reading("anthony", 10, 40) }, { readAt: () => NOW - MINUTE });
    battery.markExhausted("daniel", { resetsAt: MONDAY_NINE, kind: "weekly" });
    expect(battery.restOf(claude("daniel"), ACCOUNTS)?.until).toBe(earlier);
    advance(Date.parse(earlier) - NOW + MINUTE);
    expect(battery.restOf(claude("daniel"), ACCOUNTS)).toBeUndefined();
    readings.daniel = reading("daniel", 0, 100, { weekly: window(100, at(-HOUR)) });
    expect(battery.restOf(claude("daniel"), ACCOUNTS)?.until).toBe(MONDAY_NINE);
  });

  it("still rests the whole account for a real 5-hour or weekly limit until it resets", () => {
    const { battery, advance } = home({ daniel: reading("daniel", 100, 40), anthony: reading("anthony", 10, 100) });
    expect(battery.status(ACCOUNTS).resting).toMatchObject({ daniel: { until: SESSION_RESET, kind: "session" }, anthony: { until: WEEK_RESET, kind: "weekly" } });
    battery.markExhausted("daniel", { resetsAt: SESSION_RESET, kind: "session" }, OPUS);
    expect(battery.route(on("daniel", OPUS), ACCOUNTS, "dog")).toEqual(on("daniel", OPUS));
    expect(battery.decide(on("daniel", FABLE), ACCOUNTS, "dog")).toMatchObject({ kind: "waiting", until: SESSION_RESET });
    advance(Date.parse(SESSION_RESET) - NOW + 1);
    expect(battery.status(ACCOUNTS).resting).not.toHaveProperty("daniel");
  });
});

describe("the plan usage report", () => {
  const CODEX: BatteryAccount = { instanceId: "chatgpt", driverKind: "codex", displayName: "ChatGPT plan", enabled: true, eligible: true, signedIn: true, models: ["gpt-6.1-sol"] };
  const everyone = [claude("jacob"), claude("adam"), claude("daniel"), claude("beth"), claude("cara"), claude("anthony"), CODEX];
  const codexRow = (credits?: PlanProviderRow["credits"]): PlanProviderRow => ({
    id: "chatgpt", name: "ChatGPT plan", driver: "codex", plan: "plus", ok: true, error: null,
    fiveHour: window(0, SESSION_RESET), weekly: window(100, "2026-11-18T03:00:00.000Z"), extra: [], models: [], ...(credits ? { credits } : {}),
  });

  function report(chatgpt: PlanProviderRow) {
    const rows: Record<string, PlanProviderRow> = {
      jacob: reading("jacob", 0, 100, { weekly: window(100, "2026-11-14T22:00:00.000Z") }),
      adam: reading("adam", 100, 41),
      daniel: reading("daniel", 0, 69, { models: [fableWeek(100)] }),
      beth: reading("beth", 40, 40),
      cara: { ...reading("cara", 0, 0), ok: false, error: "Sign in again in Claude" },
      anthony: reading("anthony", 12, 40),
      chatgpt,
    };
    const battery = new AccountBattery({ config: () => ({ enabled: true, order: {} }), now: () => NOW, usage: (id) => rows[id], usageAt: () => NOW - MINUTE });
    battery.markExhausted("daniel", { resetsAt: MONDAY_NINE, kind: "seven_day_overage_included" }, FABLE);
    battery.markExhausted("beth");
    battery.needsSetup("cara");
    const shown = withAccountLimits({ fetchedAt: at(0), providers: Object.values(rows) }, (id) => {
      const account = everyone.find((candidate) => candidate.instanceId === id);
      return account ? battery.limitsOf(account, everyone) : undefined;
    });
    return Object.fromEntries(shown.providers.map((row) => [row.id, { restingUntil: row.restingUntil, limitsHit: row.limitsHit }]));
  }

  it("says which limit is hit and until when, for each case", () => {
    expect(report(codexRow())).toEqual({
      jacob: { restingUntil: "2026-11-14T22:00:00.000Z", limitsHit: [{ limit: "week", label: "Weekly limit", until: "2026-11-14T22:00:00.000Z" }] },
      adam: { restingUntil: SESSION_RESET, limitsHit: [{ limit: "session", label: "5-hour limit", until: SESSION_RESET }] },
      daniel: { restingUntil: undefined, limitsHit: [{ limit: "model", model: "Fable", label: "Fable weekly limit", until: WEEK_RESET }] },
      beth: { restingUntil: at(5 * HOUR), limitsHit: [{ limit: "other", label: "Usage limit", until: at(5 * HOUR), estimated: true }] },
      cara: { restingUntil: at(30 * MINUTE), limitsHit: [{ limit: "signIn", label: "Sign-in needed", until: at(30 * MINUTE) }] },
      anthony: { restingUntil: undefined, limitsHit: [] },
      chatgpt: { restingUntil: "2026-11-18T03:00:00.000Z", limitsHit: [{ limit: "week", label: "Weekly limit", until: "2026-11-18T03:00:00.000Z" }] },
    });
  });

  it("keeps the ChatGPT plan running on its paid credits and carries the balance it reads", () => {
    expect(report(codexRow({ unlimited: false, balance: "12.40" })).chatgpt).toEqual({ restingUntil: undefined, limitsHit: [] });
  });

  it("puts the whole-account limit first, then one model's, and the dogs' text says the same words", () => {
    const rows = { daniel: reading("daniel", 100, 69, { models: [fableWeek(100)] }) };
    const battery = new AccountBattery({ config: () => CONFIG, now: () => NOW, usage: (id) => rows[id as "daniel"], usageAt: () => NOW - MINUTE });
    battery.markExhausted("daniel", { resetsAt: MONDAY_NINE, kind: "fable" }, FABLE);
    const limits = battery.limitsOf(claude("daniel"), ACCOUNTS);
    expect(withAccountLimits({ fetchedAt: at(0), providers: [rows.daniel] }, () => limits).providers[0]).toMatchObject({
      restingUntil: SESSION_RESET,
      limitsHit: [{ limit: "session", label: "5-hour limit", until: SESSION_RESET }, { limit: "model", model: "Fable", label: "Fable weekly limit", until: WEEK_RESET }],
    });
    const usage = accountUsage([{ account: claude("daniel"), row: rows.daniel, rest: battery.restOf(claude("daniel"), ACCOUNTS), limits }], undefined, NOW);
    expect(accountUsageText(usage, NOW, "America/Los_Angeles")).toContain(
      "- daniel [id: daniel, Claude]: resting until 3:49 PM. 5-hour limit reached. Fable weekly limit reached until Mon 8:59 AM, other models still run. 5-hour 100% used",
    );
  });

  it("tells a dog that daniel has room, and that only Fable waits", () => {
    const rows = { daniel: reading("daniel", 0, 69) };
    const battery = new AccountBattery({ config: () => CONFIG, now: () => NOW, usage: (id) => rows[id as "daniel"] });
    battery.markExhausted("daniel", { resetsAt: MONDAY_NINE, kind: "seven_day_overage_included" }, FABLE);
    const usage = accountUsage([{ account: claude("daniel"), row: rows.daniel, rest: battery.restOf(claude("daniel"), ACCOUNTS), limits: battery.limitsOf(claude("daniel"), ACCOUNTS) }], undefined, NOW);
    expect(accountUsageText(usage, NOW, "America/Los_Angeles")).toContain(
      "- daniel [id: daniel, Claude, most room]: 31% left. Fable weekly limit reached until Mon 9:00 AM, other models still run. 5-hour 0% used, resets 3:49 PM; 7-day 69% used, resets Mon 8:59 AM.",
    );
  });
});

describe("the Claude (API key) entry", () => {
  it("has no plan usage row, so it never shows the readings of the account signed in on this home", async () => {
    const instances = instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } } as unknown as AppConfig);
    expect(instances.claudeApi).toMatchObject({ driver: "claudeAgent", displayName: "Claude (API key)" });
    const accounts = planAccountsFromInstances(instances).filter((account) => account.driver === "claude");
    expect(accounts.map((account) => account.id)).toEqual(["claude"]);
    const credentials = fileCredentialReader({
      env: { HOME: "/home/fixture" },
      now: () => NOW,
      readText: (path) => path === join("/home/fixture", ".claude", ".credentials.json")
        ? JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access", expiresAt: NOW + HOUR } })
        : null,
    });
    const reply: PlanResponse = { ok: true, status: 200, text: async () => JSON.stringify({ five_hour: { utilization: 0, resets_at: SESSION_RESET }, seven_day: { utilization: 69, resets_at: WEEK_RESET } }) };
    const usage = await loadPlanUsage({ accounts: planAccountsFromInstances(instances), refresh: true, now: NOW, fetch: async () => reply, credentials });
    expect(usage.providers.map((row) => row.id)).not.toContain("claudeApi");
    expect(usage.providers.find((row) => row.id === "claude")?.weekly.usedPercent).toBe(69);
  });
});
