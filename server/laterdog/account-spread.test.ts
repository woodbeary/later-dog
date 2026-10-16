import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanProviderRow } from "../plan-usage.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { AccountBattery, type AccountBatteryConfig, type BatteryAccount } from "./account-battery.ts";
import { homeAccount, leastLoaded, runningByAccount } from "./account-spread.ts";

const NOW = Date.parse("2026-10-15T18:00:00Z");
const HOUR = 3600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const claude = (instanceId: string, extra: Partial<BatteryAccount> = {}): BatteryAccount => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, enabled: true, eligible: true, signedIn: true,
  models: ["claude-opus-5", "claude-sonnet-5"], ...extra,
});
const codex = (instanceId: string): BatteryAccount => ({
  instanceId, driverKind: "codex", displayName: instanceId, enabled: true, eligible: true, signedIn: true, models: ["gpt-5.5"], defaultModel: "gpt-5.5",
});
const ACCOUNTS = [claude("claude"), claude("claude-2"), claude("claude-3"), codex("chatgpt")];
const ON: AccountBatteryConfig = { enabled: true, order: { claudeAgent: ["claude", "claude-2", "claude-3"], codex: ["chatgpt"] } };
const DOG = { instanceId: "claude", model: "claude-opus-5", effort: "high" as const };
const reading = (usedPercent: number): PlanProviderRow => ({
  ok: true, fiveHour: { available: true, usedPercent, resetsAt: at(HOUR) }, weekly: { available: true, usedPercent: 0, resetsAt: at(48 * HOUR) },
  extra: [], models: [],
} as unknown as PlanProviderRow);

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

function battery(extra: { config?: AccountBatteryConfig; accounts?: BatteryAccount[]; usage?: Record<string, number>; file?: string; defaultAccount?: string } = {}) {
  const running: Record<string, number> = {};
  const accounts = extra.accounts ?? ACCOUNTS;
  const instance = new AccountBattery({
    config: () => extra.config ?? ON, accounts: () => accounts, now: () => NOW, running: () => running,
    defaultAccount: () => extra.defaultAccount ?? "claude",
    ...(extra.usage ? { usage: (id: string) => extra.usage![id] === undefined ? undefined : reading(extra.usage![id]!) } : {}),
    ...(extra.file ? { file: extra.file } : {}),
  });
  const start = (threadId: string, selection = DOG) => {
    const routed = instance.route(selection, accounts, threadId);
    running[routed.instanceId] = (running[routed.instanceId] ?? 0) + 1;
    return { routed, notice: instance.arrive(threadId, selection, routed.instanceId, accounts) };
  };
  const finish = (instanceId: string) => { running[instanceId] = (running[instanceId] ?? 1) - 1; };
  return { instance, running, start, finish, accounts };
}

describe("choosing an account for a new conversation", () => {
  it("prefers the account with the fewest dogs running, then the dog's own, then the most left, then the person's order", () => {
    const base = { own: false, running: 0, index: 0 };
    expect(leastLoaded([{ ...base, instanceId: "a", running: 2, own: true }, { ...base, instanceId: "b", running: 1, index: 1 }])).toBe("b");
    expect(leastLoaded([{ ...base, instanceId: "a", own: true, left: 10 }, { ...base, instanceId: "b", left: 90, index: 1 }])).toBe("a");
    expect(leastLoaded([{ ...base, instanceId: "b", index: 1 }, { ...base, instanceId: "c", left: 40, index: 2 }, { ...base, instanceId: "d", left: 70, index: 3 }])).toBe("d");
    expect(leastLoaded([{ ...base, instanceId: "c", index: 2 }, { ...base, instanceId: "b", index: 1 }])).toBe("b");
    expect(leastLoaded([])).toBeUndefined();
  });

  it("counts each running conversation once, wherever it is listed", () => {
    expect(runningByAccount([["t1", "claude"], ["t2", "claude"]], [["t1", "claude-2"], ["t3", "chatgpt"]])).toEqual({ claude: 2, chatgpt: 1 });
  });

  it("treats the default account, or else the first in the order, as a dog's home", () => {
    expect(homeAccount(["claude", "claude-2"], "claude-2")).toBe("claude-2");
    expect(homeAccount(["claude", "claude-2"], "chatgpt")).toBe("claude");
    expect(homeAccount([], undefined)).toBeUndefined();
  });
});

describe("spreading dogs across accounts", () => {
  it("starts three dogs that work at once on three accounts instead of draining one together, without a word in the chat", () => {
    const { start } = battery();
    const placed = ["dog-1", "dog-2", "dog-3"].map((threadId) => start(threadId));
    expect(placed.map(({ routed }) => routed.instanceId)).toEqual(["claude", "claude-2", "claude-3"]);
    expect(placed.map(({ routed }) => routed)).toEqual([DOG, { ...DOG, instanceId: "claude-2" }, { ...DOG, instanceId: "claude-3" }]);
    expect(placed.map(({ notice }) => notice)).toEqual([undefined, undefined, undefined]);
  });

  it("among idle accounts keeps the dog's own, then picks the one with the most left", () => {
    expect(battery({ usage: { claude: 90, "claude-2": 10, "claude-3": 50 } }).start("dog-1").routed.instanceId).toBe("claude");
    const busy = battery({ usage: { claude: 90, "claude-2": 80, "claude-3": 20 } });
    busy.running.claude = 1;
    expect(busy.start("dog-2").routed.instanceId).toBe("claude-3");
  });

  it("keeps a conversation on the account it is on while that account can run, so its session and cache stay", () => {
    const { start, finish, running } = battery();
    start("dog-1");
    start("dog-2");
    finish("claude-2");
    running.claude = 5;
    expect(start("dog-2").routed.instanceId).toBe("claude-2");
    expect(start("dog-1").routed.instanceId).toBe("claude");
  });

  it("never spreads a dog the person put on a particular account", () => {
    const { start, running } = battery();
    running["claude-2"] = 3;
    expect(start("pinned", { ...DOG, instanceId: "claude-2" }).routed.instanceId).toBe("claude-2");
    const other = battery({ defaultAccount: "claude-2" });
    other.running.claude = 2;
    expect(other.start("pinned", DOG).routed.instanceId).toBe("claude");
  });

  it("stays on the dog's engine: it does not move to Codex while a Claude account can run", () => {
    const { start, running } = battery({ accounts: [claude("claude"), codex("chatgpt")] });
    running.claude = 4;
    expect(start("dog-1").routed).toBe(DOG);
  });

  it("spreads nothing while keep-going is off, and lets the person's own pick win", () => {
    const off = battery({ config: { ...ON, enabled: false } });
    off.running.claude = 3;
    expect(off.start("dog-1").routed).toBe(DOG);
    const { instance, start, running } = battery();
    instance.markExhausted("claude", { resetsAt: at(HOUR) });
    instance.choose("dog-1", "claude", "claude-3", "claude");
    running["claude-3"] = 9;
    expect(start("dog-1").routed.instanceId).toBe("claude-3");
  });

  it("leaves rooms alone: only a dog's own conversations spread", () => {
    const running: Record<string, number> = { claude: 2 };
    const room = new AccountBattery({ config: () => ON, accounts: () => ACCOUNTS, now: () => NOW, running: () => running,
      ownThread: (threadId) => threadId !== "room-thread" });
    expect(room.route(DOG, ACCOUNTS, "room-thread")).toBe(DOG);
    expect(room.route(DOG, ACCOUNTS, "dog-thread").instanceId).toBe("claude-2");
  });

  it("counts two accounts signed in to one login as one", () => {
    const shared = [claude("claude", { email: "jacob@example.test" }), claude("claude-2", { email: "Jacob@example.test" }), claude("claude-3")];
    const { start, running } = battery({ accounts: shared });
    running.claude = 1;
    expect(start("dog-1").routed.instanceId).toBe("claude-3");
  });

  it("brings a conversation that fell back home when its account recharges, and says so", () => {
    const { instance, start, finish } = battery();
    instance.markExhausted("claude", { resetsAt: at(HOUR), kind: "session" });
    const fell = start("dog-1");
    expect(fell.routed.instanceId).toBe("claude-2");
    expect(fell.notice).toMatch(/^Running on claude-2 — claude is recharging/);
    finish("claude-2");
    expect(start("dog-1").notice).toBeUndefined();
    finish("claude-2");
    expect(instance.recovered("claude", NOW + 1)).toBe(true);
    const home = start("dog-1");
    expect(home.routed).toBe(DOG);
    expect(home.notice).toBe("Back on claude.");
  });

  it("remembers where each conversation runs across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-spread-"));
    dirs.push(dir);
    const file = join(dir, "account-battery.json");
    const first = battery({ file });
    first.start("dog-1");
    first.start("dog-2");
    const second = battery({ file });
    second.running.claude = 4;
    expect(second.start("dog-2").routed.instanceId).toBe("claude-2");
    second.instance.forget("claude-2");
    expect(second.start("dog-2").routed.instanceId).toBe("claude-3");
  });
});
