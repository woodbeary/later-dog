// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import type { PlanProvider, PlanUsageReport } from "./PlanUsage";

const fixture = vi.hoisted(() => ({
  carryOn: { on: false, saving: false, error: null as string | null, set: (async () => {}) as (on: boolean) => Promise<void> },
}));
vi.mock("./AccountsPanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AccountsPanel")>()),
  useCarryOn: () => fixture.carryOn,
}));

const { AccountSwitcher, UsageRing, usageRingFor } = await import("./AccountSwitcher");

const NOW = Date.UTC(2026, 9, 9, 12);
const account = (instanceId: string, displayName: string, driverKind = "claudeAgent", authenticated = true) => ({
  instanceId, driverKind, displayName, access: "subscription",
  snapshot: { state: "available", version: "1.0.0", authenticated },
  models: { default: "model", options: [{ id: "model", label: "Model" }] },
}) as InstanceInfo;
const usage = (id: string, fiveHour: number, weekly: number): PlanProvider => ({
  id, name: id, driver: "claude", plan: "Max", ok: true, error: null, extra: [],
  fiveHour: { available: true, remainingPercent: 100 - fiveHour, usedPercent: fiveHour, resetsAt: new Date(NOW + 80 * 60_000).toISOString() },
  weekly: { available: true, remainingPercent: 100 - weekly, usedPercent: weekly, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
});
const personal = account("claude", "Personal");
const work = account("claude-work", "Work");
const codex = account("codex", "Codex", "codex");
const old = account("claude-old", "Old", "claudeAgent", false);
const report: PlanUsageReport = { fetchedAt: new Date(NOW).toISOString(), providers: [usage("claude", 62, 40), usage("claude-work", 10, 95)] };

let root: Root | null = null;
const show = (props: Partial<Parameters<typeof AccountSwitcher>[0]> = {}) => {
  const onPick = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(AccountSwitcher, {
    accounts: [personal, work, codex, old], currentId: "claude", report, loading: true, now: NOW, resting: undefined, onPick, ...props,
  })));
  return onPick;
};
const row = (id: string) => document.querySelector<HTMLButtonElement>(`[data-account="${id}"]`)!;
const carryOnSwitch = () => document.querySelector<HTMLButtonElement>('[role="switch"]');

beforeEach(() => {
  fixture.carryOn = { on: false, saving: false, error: null, set: vi.fn(async () => {}) };
});
afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("the account list", () => {
  it("shows each account's tighter limit as a bar with its reset, and checks the one in use", () => {
    show();
    expect(row("claude").textContent).toContain("62% used · resets in 1h 20m");
    expect(row("claude").querySelector('[role="meter"]')!.getAttribute("aria-valuenow")).toBe("62");
    expect(row("claude").querySelector('[role="meter"] > span')!.className).toContain("bg-accent");
    expect(row("claude-work").textContent).toContain("95% used · resets in 3d");
    expect(row("claude-work").querySelector('[role="meter"]')!.getAttribute("aria-label")).toBe("Work · Weekly");
    expect(row("claude-work").querySelector('[role="meter"] > span')!.className).toContain("bg-danger");
    expect(row("claude-work").title).toBe("Work\n5-hour · 10% used · resets in 1h 20m\nWeekly · 95% used · resets in 3d");
    expect(row("codex").textContent).toContain("Checking usage…");
    expect(row("codex").querySelector('[role="meter"]')).toBeNull();
    expect(row("claude-old").textContent).toContain("Not signed in");
    expect(row("claude").getAttribute("aria-pressed")).toBe("true");
    expect(row("claude-work").getAttribute("aria-pressed")).toBe("false");
  });

  it("says a resting account rests until its reset instead of showing a bar", () => {
    show({ resting: { "claude-work": { until: new Date(NOW + 3_600_000).toISOString() } } });
    expect(row("claude-work").textContent).toContain("Resting until");
    expect(row("claude-work").querySelector('[role="meter"]')).toBeNull();
    expect(row("claude-work").title).toMatch(/^Work\nResting until /);
  });

  it("forgets a rest that is over", () => {
    show({ resting: { "claude-work": { until: new Date(NOW - 1).toISOString() } } });
    expect(row("claude-work").textContent).not.toContain("Resting until");
    expect(row("claude-work").textContent).toContain("95% used");
  });

  it("switches account on a tap", () => {
    const onPick = show();
    row("claude-work").click();
    expect(onPick).toHaveBeenCalledWith(work);
  });

  it("offers carry-on with any accounts, and saves the flip", () => {
    show({ accounts: [personal, codex] });
    expect(carryOnSwitch()!.getAttribute("aria-label")).toBe("Keep going when an account runs out");
    expect(carryOnSwitch()!.getAttribute("aria-checked")).toBe("false");
    carryOnSwitch()!.click();
    expect(fixture.carryOn.set).toHaveBeenCalledWith(true);
  });

  it("says when the carry-on setting could not be saved", () => {
    fixture.carryOn = { ...fixture.carryOn, on: true, error: "Could not save this setting. Please try again." };
    show({ accounts: [personal, work] });
    expect(carryOnSwitch()!.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[role="alert"]')!.textContent).toBe("Could not save this setting. Please try again.");
  });
});

describe("the usage ring", () => {
  it("fills to the tighter limit in its tone, and full red while the account rests", () => {
    expect(usageRingFor(usage("claude", 80, 30), undefined)).toEqual({ used: 80, tone: "warning" });
    expect(usageRingFor(usage("claude", 20, 95), undefined)).toEqual({ used: 95, tone: "danger" });
    expect(usageRingFor(usage("claude", 20, 30), { until: new Date(NOW + 1).toISOString() })).toEqual({ used: 100, tone: "danger" });
    expect(usageRingFor(undefined, undefined)).toBeNull();
    expect(usageRingFor({ ...usage("claude", 20, 30), ok: false }, undefined)).toBeNull();
  });

  it("draws an arc only for usage above zero", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root!.render(createElement(UsageRing, { used: 40, tone: "accent", children: createElement("i") })));
    expect(container.querySelector("[data-usage-ring]")!.getAttribute("data-usage-ring")).toBe("40");
    expect(container.querySelectorAll("circle")).toHaveLength(2);
    expect(container.querySelectorAll("circle")[1].getAttribute("class")).toBe("text-accent");
    flushSync(() => root!.render(createElement(UsageRing, { used: 0, tone: "accent", children: createElement("i") })));
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });
});
