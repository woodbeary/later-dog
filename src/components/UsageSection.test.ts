// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, TaskUsage } from "@/state/store";
import type { PlanProvider } from "./PlanUsage";
import type { UsageGroup, UsageSummary } from "./UsageHistory";

const fixture = vi.hoisted(() => ({
  state: null as unknown as AppState,
  providers: [] as PlanProvider[],
  ledger: new Map<string, UsageSummary>(),
  api: vi.fn(),
}));

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, api: fixture.api, useStore: () => ({ state: fixture.state, dispatch: vi.fn() }) };
});
vi.mock("./PlanUsage", async (original) => ({
  ...await original<typeof import("./PlanUsage")>(),
  usePlanUsage: () => ({ report: { fetchedAt: "", providers: fixture.providers }, loading: false, error: "", now: Date.now(), reload: vi.fn() }),
}));

const { initialState } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");
const { usagePeriodRange } = await import("./UsageHistory");
const { UsageSection } = await import("./UsageSection");

const HOUR = 3_600_000;
const usage = (patch: Partial<TaskUsage>): TaskUsage => ({ input: 1_000, output: 200, costUsd: null, turns: 1, ...patch });
const dog = (name: string, instanceId: string, spent: TaskUsage, patch: Partial<Bot> = {}): Bot => ({
  id: name.toLowerCase(), threadId: `thread-${name.toLowerCase()}`, name, title: "", description: "",
  notifications: false, color: "green", unread: false,
  modelSelection: { instanceId, model: "fixture-model" },
  tasks: [{ threadId: `thread-${name.toLowerCase()}`, title: "Task", createdAt: 0, usage: spent }],
  messages: [],
  ...patch,
});
const account = (instanceId: string, displayName: string, patch: Partial<InstanceInfo> = {}, snapshot: Partial<InstanceInfo["snapshot"]> = {}): InstanceInfo => ({
  instanceId, driverKind: "claudeAgent", displayName, access: "subscription",
  snapshot: { state: "available", authenticated: true, billing: "subscription", ...snapshot },
  models: { default: "fixture-model", options: [] },
  ...patch,
});
const closed = { available: false, remainingPercent: null, usedPercent: null, resetsAt: null };
const reading = (id: string, name: string, patch: Partial<PlanProvider> = {}): PlanProvider => ({
  id, name, driver: "claude", plan: null, ok: true, error: null,
  fiveHour: { available: true, remainingPercent: 68, usedPercent: 32, resetsAt: new Date(Date.now() + 2 * HOUR).toISOString() },
  weekly: closed, extra: [], models: [],
  ...patch,
});
const group = (label: string, turns: number, costUsd: number | null): UsageGroup => ({
  key: `bot:${label.toLowerCase()}`, label, turns, input: turns * 12, output: turns * 5, cachedInput: 0, costUsd, unpriced: 0,
});
const summary = (groups: UsageGroup[]): UsageSummary => {
  const priced = groups.some((each) => each.costUsd !== null);
  const total = groups.reduce((sum, each) => sum + (each.costUsd ?? 0), 0);
  return {
    from: "", to: "", groupBy: "bot", groups,
    total: { ...group("Total", groups.reduce((sum, each) => sum + each.turns, 0), priced ? Math.round(total * 100) / 100 : null), key: "total" },
  };
};

let host: HTMLDivElement;
let root: Root;
const yearAgo = () => usagePeriodRange("year").from;
const text = () => host.textContent?.replace(/\s+/g, " ") ?? "";
const rows = () => [...host.querySelectorAll<HTMLElement>("[data-usage-account]")];

async function show(bots: Bot[], instances: InstanceInfo[], ledger: UsageGroup[]) {
  fixture.state = { ...initialState, bots, instances };
  fixture.ledger = new Map([["year", summary(ledger)], ["month", summary(ledger)]]);
  await act(async () => root.render(createElement(UsageSection)));
  await act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
}

beforeEach(() => {
  setLocale("en");
  fixture.providers = [];
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => {
    const from = new URL(path, "http://fixture.test").searchParams.get("from");
    return fixture.ledger.get(from === yearAgo() ? "year" : "month");
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the Usage page", () => {
  it("shows the accounts, then the cost so far, then the history, and no budget", async () => {
    await show([dog("Atlas", "claude", usage({ costUsd: 0.3, turns: 2 }))], [account("claude", "Personal")], [group("Atlas", 2, 0.3)]);
    const order = ["data-plan-usage", "data-usage-cost", "data-usage-history"].map((marker) => host.innerHTML.indexOf(marker));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text()).not.toMatch(/budget|sell price/i);
  });

  it("lists only the accounts you sign in to, each with one plain line", async () => {
    fixture.providers = [
      reading("claude", "Personal", { plan: "Max" }),
      reading("claude-work", "Work", { ok: false, error: "Sign in again in Claude" }),
      reading("chatgpt", "ChatGPT", { driver: "codex", ok: false, error: "Sign in again in Codex" }),
      reading("claudeApi", "Claude (API key)", { ok: false, error: "Sign in again in Claude" }),
    ];
    await show([], [
      account("claude", "Personal"),
      account("claude-work", "Work", {}, { authenticated: false }),
      account("chatgpt", "ChatGPT", { driverKind: "codex" }),
      account("claudeApi", "Claude (API key)", { access: "api" }, { billing: "metered", account: { method: "api-key" } }),
    ], []);
    expect(rows().map((row) => row.dataset.usageAccount)).toEqual(["claude", "claude-work", "chatgpt"]);
    expect(rows()[0]!.textContent).toContain("PersonalMax");
    expect(rows()[0]!.querySelector('[role="meter"]')).not.toBeNull();
    expect(rows()[1]!.textContent).toBe("WorkNot signed in");
    expect(rows()[2]!.textContent).toBe("ChatGPT");
    expect(text()).not.toMatch(/API key|Codex|Sign in again/);
  });

  it("takes the cost so far from the same record as the history, background work included", async () => {
    await show(
      [dog("Atlas", "claude", usage({ costUsd: 0.02, turns: 2 })), dog("Pesto", "claude", usage({ costUsd: 0.01 }))],
      [account("claude", "Personal")],
      [group("Atlas", 3, 0.03), group("Pesto", 1, 0.01)],
    );
    expect(text()).toContain("Estimated cost so far$0.04");
    expect(text()).toContain("Cost is equivalent — on your subscription, not billed.");
    expect(host.querySelector("[data-usage-history]")!.textContent).toContain("Total468$0.04");
    expect(host.querySelector("[data-usage-dogs]")).toBeNull();
    expect(fixture.api.mock.calls.some(([path]) => String(path).includes(`from=${yearAgo()}&`))).toBe(true);
  });

  it("says when the dogs run on different kinds of billing", async () => {
    await show(
      [dog("Atlas", "claude", usage({ costUsd: 0.3 })), dog("Juniper", "openai", usage({ costUsd: 0.1 }))],
      [account("claude", "Personal"), account("openai", "OpenAI", { access: "api" }, { billing: "metered" })],
      [group("Atlas", 1, 0.3), group("Juniper", 1, 0.1)],
    );
    expect(text()).toContain("Cost is as each provider reports it");
  });

  it("says no price was reported when the turns carry none", async () => {
    await show([dog("Atlas", "claude", usage({}))], [account("claude", "Personal")], [group("Atlas", 1, null)]);
    expect(text()).toContain("Estimated cost so far—No price reported yet");
  });

  it("starts empty", async () => {
    await show([], [account("claude", "Personal")], []);
    expect(text()).toContain("Estimated cost so far—Nothing spent yet");
  });
});

describe("the year the cost so far covers", () => {
  it("is the longest range the history can read", () => {
    const range = usagePeriodRange("year", new Date("2026-10-10T23:30:00Z"));
    expect(range).toEqual({ from: "2025-10-10", to: "2026-10-10" });
    const days = (Date.parse(`${range.to}T23:59:59.999Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000;
    expect(days).toBeLessThanOrEqual(366);
  });
});
