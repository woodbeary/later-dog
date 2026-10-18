// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, InstanceInfo } from "@/state/store";
import type { PlanProvider } from "./PlanUsage";

const fixture = vi.hoisted(() => ({
  state: null as unknown as AppState,
  providers: [] as PlanProvider[],
}));

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, useStore: () => ({ state: fixture.state, dispatch: vi.fn() }) };
});
vi.mock("./PlanUsage", async (original) => ({
  ...await original<typeof import("./PlanUsage")>(),
  usePlanUsage: () => ({ report: { fetchedAt: "", providers: fixture.providers }, loading: false, error: "", now: Date.now(), reload: vi.fn() }),
}));

const { initialState } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");
const { UsageSection } = await import("./UsageSection");

const HOUR = 3_600_000;
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
let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent?.replace(/\s+/g, " ") ?? "";
const rows = () => [...host.querySelectorAll<HTMLElement>("[data-usage-account]")];

async function show(instances: InstanceInfo[]) {
  fixture.state = { ...initialState, bots: [], instances };
  await act(async () => root.render(createElement(UsageSection)));
  await act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
}

beforeEach(() => {
  setLocale("en");
  fixture.providers = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the Usage & Billing page", () => {
  it("shows the accounts and nothing else: no cost so far, no history and no budget", async () => {
    await show([account("claude", "Personal")]);
    expect(host.innerHTML).toContain("data-plan-usage");
    expect(host.innerHTML).not.toContain("data-usage-cost");
    expect(host.innerHTML).not.toContain("data-usage-history");
    expect(text()).not.toMatch(/budget|sell price|cost so far/i);
  });

  it("lists only the accounts you sign in to, each with one plain line", async () => {
    fixture.providers = [
      reading("claude", "Personal", { plan: "Max" }),
      reading("claude-work", "Work", { ok: false, error: "Sign in again in Claude" }),
      reading("chatgpt", "ChatGPT", { driver: "codex", ok: false, error: "Sign in again in Codex" }),
      reading("claudeApi", "Claude (API key)", { ok: false, error: "Sign in again in Claude" }),
    ];
    await show([
      account("claude", "Personal"),
      account("claude-work", "Work", {}, { authenticated: false }),
      account("chatgpt", "ChatGPT", { driverKind: "codex" }),
      account("claudeApi", "Claude (API key)", { access: "api" }, { billing: "metered", account: { method: "api-key" } }),
    ]);
    expect(rows().map((row) => row.dataset.usageAccount)).toEqual(["claude", "claude-work", "chatgpt"]);
    expect(rows()[0]!.textContent).toContain("PersonalMax");
    expect(rows()[0]!.querySelector('[role="meter"]')).not.toBeNull();
    expect(rows()[1]!.textContent).toBe("WorkNot signed in");
    expect(rows()[2]!.textContent).toBe("ChatGPT");
    expect(text()).not.toMatch(/API key|Codex|Sign in again/);
  });
});
