// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import type { PlanProvider, PlanUsageReport } from "./PlanUsage";

const fixture = vi.hoisted(() => ({
  carryOn: {
    on: false, saving: false, error: null as string | null, canReorder: true,
    set: (async () => {}) as (on: boolean) => Promise<void>,
    reorder: (async () => {}) as (shown: readonly string[]) => Promise<void>,
  },
}));
vi.mock("./AccountsPanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AccountsPanel")>()),
  useCarryOn: () => fixture.carryOn,
}));

const { ACCOUNT_DRAG_TYPE, AccountBadge, accountInitials, AccountSwitcher, movedTo, UsageRing, usageRingFor } = await import("./AccountSwitcher");

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
const show = async (props: Partial<Parameters<typeof AccountSwitcher>[0]> = {}) => {
  const onPick = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(AccountSwitcher, {
    accounts: [personal, work, codex, old], currentId: "claude", report, now: NOW, resting: undefined, onPick, ...props,
  })));
  return onPick;
};
const row = (id: string) => document.querySelector<HTMLButtonElement>(`[data-account="${id}"]`);
const item = (id: string) => document.querySelector<HTMLElement>(`[data-account-row="${id}"]`)!;
const ring = (id: string) => row(id)!.querySelector("[data-usage-ring]");
const order = () => [...document.querySelectorAll<HTMLElement>("[data-account]")].map((element) => element.dataset.account);
const carryOnSwitch = () => document.querySelector<HTMLButtonElement>('[role="switch"]');
const drag = async (element: Element, type: "dragstart" | "dragover" | "drop" | "dragend", transfer: DataTransfer) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return event;
};
const press = async (element: Element, key: string, altKey = true) => {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, altKey, bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.carryOn = { on: false, saving: false, error: null, canReorder: true, set: vi.fn(async () => {}), reorder: vi.fn(async () => {}) };
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the account list", () => {
  it("gives each account one line with a usage ring, leaves the detail to the tooltip, and checks the one in use", async () => {
    await show();
    expect(order()).toEqual(["claude", "claude-work", "codex"]);
    expect(row("claude")!.textContent).toBe("Personal38% left");
    expect(ring("claude")!.getAttribute("data-usage-ring")).toBe("38");
    expect(ring("claude-work")!.getAttribute("data-usage-ring")).toBe("5");
    expect(ring("claude-work")!.querySelectorAll("circle")[1].getAttribute("class")).toBe("text-danger");
    expect(ring("claude-work")!.hasAttribute("data-charging")).toBe(false);
    expect(document.querySelector('[role="meter"]')).toBeNull();
    expect(document.querySelector("[data-sleeping-dog]")).toBeNull();
    expect(row("claude-work")!.title).toBe("Work\n5-hour · 90% left · resets in 1h 20m\nWeekly · 5% left · resets in 3d");
    expect(row("codex")!.textContent).toBe("Codex");
    expect(ring("codex")).toBeNull();
    expect(row("claude")!.getAttribute("aria-pressed")).toBe("true");
    expect(row("claude-work")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("leaves out a signed-out account", async () => {
    await show();
    expect(row("claude-old")).toBeNull();
  });

  it("keeps a signed-out account while it is the one in use, and says so", async () => {
    await show({ currentId: "claude-old" });
    expect(row("claude-old")!.textContent).toBe("OldNot signed in");
    expect(row("claude-old")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("puts a resting account to sleep, rings how far it has recharged, and says when it is back", async () => {
    await show({ resting: { "claude-work": { since: new Date(NOW - 3_600_000).toISOString(), until: new Date(NOW + 3_600_000).toISOString() } } });
    expect(row("claude-work")!.textContent).toMatch(/^WorkBack at \d{1,2}:\d{2}/);
    expect(row("claude-work")!.querySelector("[data-sleeping-dog]")!.textContent).toBe("");
    expect(ring("claude-work")!.getAttribute("data-usage-ring")).toBe("50");
    expect(ring("claude-work")!.getAttribute("data-charging")).toBe("true");
    expect(ring("claude-work")!.querySelectorAll("circle")[1].getAttribute("class")).toBe("text-accent recharge-pulse");
    expect(row("claude-work")!.title).toMatch(/^Work\nBack at [^\n]+ · in 1h$/);
  });

  it("says only roughly when a rest without a known reset ends", async () => {
    await show({ resting: { "claude-work": { since: new Date(NOW - 3_600_000).toISOString(), until: new Date(NOW + 3_600_000).toISOString(), estimated: true } } });
    expect(row("claude-work")!.textContent).toContain("Recharging");
    expect(ring("claude-work")!.getAttribute("data-usage-ring")).toBe("unknown");
    expect(row("claude-work")!.title).not.toContain(" · in ");
  });

  it("sleeps at a reported full limit without inventing recharge progress", async () => {
    await show({ report: { ...report, providers: [usage("claude", 100, 30), usage("claude-work", 99.6, 30)] } });
    expect(row("claude")!.querySelector("[data-sleeping-dog]")).not.toBeNull();
    expect(row("claude")!.textContent).toContain("0% left");
    expect(ring("claude")!.hasAttribute("data-charging")).toBe(false);
    expect(row("claude-work")!.querySelector("[data-sleeping-dog]")).toBeNull();
    expect(row("claude-work")!.textContent).toContain("0% left");
  });

  it("forgets a rest that is over", async () => {
    await show({ resting: { "claude-work": { until: new Date(NOW - 1).toISOString() } } });
    expect(row("claude-work")!.textContent).not.toContain("Back at");
    expect(row("claude-work")!.textContent).toContain("5% left");
    expect(row("claude-work")!.querySelector("[data-sleeping-dog]")).toBeNull();
  });

  it("switches account on a tap", async () => {
    const onPick = await show();
    await act(async () => row("claude-work")!.click());
    expect(onPick).toHaveBeenCalledWith(work);
  });

  it("leaves carry-on to Settings and always shows the drag handle", async () => {
    await show({ accounts: [personal, work] });
    expect(carryOnSwitch()).toBeNull();
    expect(document.querySelector("[data-account-grip]")!.className).not.toContain("opacity-0");
  });
});

describe("reordering accounts", () => {
  it("drags an account onto another of its kind, shows the new order at once, and saves it on the drop", async () => {
    await show();
    expect(item("claude").getAttribute("draggable")).toBe("true");
    expect(item("codex").getAttribute("draggable")).toBe("true");
    const transfer = new DataTransfer();
    await drag(item("claude-work"), "dragstart", transfer);
    expect(transfer.getData(ACCOUNT_DRAG_TYPE)).toBe("claude-work");
    expect(transfer.getData("text/plain")).toBe("");
    const over = await drag(item("claude"), "dragover", transfer);
    expect(over.defaultPrevented).toBe(true);
    expect(order()).toEqual(["claude-work", "claude", "codex"]);
    expect(fixture.carryOn.reorder).not.toHaveBeenCalled();
    await drag(item("claude"), "drop", transfer);
    await drag(item("claude-work"), "dragend", transfer);
    expect(fixture.carryOn.reorder).toHaveBeenCalledTimes(1);
    expect(fixture.carryOn.reorder).toHaveBeenCalledWith(["claude-work", "claude", "codex"]);
  });

  it("allows cross-provider priority changes and cancels a drag without saving", async () => {
    await show();
    const transfer = new DataTransfer();
    await drag(item("claude"), "dragstart", transfer);
    await drag(item("codex"), "dragover", transfer);
    expect(order()).toEqual(["claude-work", "codex", "claude"]);
    await drag(item("claude-work"), "dragover", transfer);
    expect(order()).toEqual(["claude", "claude-work", "codex"]);
    await drag(item("claude"), "dragend", transfer);
    expect(order()).toEqual(["claude", "claude-work", "codex"]);
    expect(fixture.carryOn.reorder).not.toHaveBeenCalled();
  });

  it("saves nothing when an account is dropped where it started", async () => {
    await show();
    const transfer = new DataTransfer();
    await drag(item("claude"), "dragstart", transfer);
    await drag(item("claude"), "drop", transfer);
    expect(fixture.carryOn.reorder).not.toHaveBeenCalled();
  });

  it("moves accounts across providers with Alt and the arrow keys", async () => {
    await show();
    expect(row("claude")!.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");
    expect(row("codex")!.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");
    await press(row("claude")!, "ArrowUp");
    await press(row("claude")!, "ArrowDown", false);
    expect(fixture.carryOn.reorder).not.toHaveBeenCalled();
    await press(row("claude")!, "ArrowDown");
    expect(fixture.carryOn.reorder).toHaveBeenCalledWith(["claude-work", "claude", "codex"]);
  });

  it("shows a grip only on an account that has somewhere to go", async () => {
    await show();
    expect(item("claude").querySelector("[data-account-grip]")!.getAttribute("title")).toBe("Drag to reorder");
    expect(item("codex").querySelector("[data-account-grip]")).not.toBeNull();
  });

  it("offers no reordering while the order cannot be saved", async () => {
    fixture.carryOn = { ...fixture.carryOn, canReorder: false };
    await show();
    expect(document.querySelector("[draggable]")).toBeNull();
    expect(document.querySelector("[data-account-grip]")).toBeNull();
    await press(row("claude")!, "ArrowDown");
    expect(fixture.carryOn.reorder).not.toHaveBeenCalled();
  });

  it("works out where a moved account lands", () => {
    expect(movedTo(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(movedTo(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(movedTo(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
  });
});

describe("the usage ring", () => {
  it("fills with what the tighter limit has used, warms from green to red as it runs low, and drains while the account rests", () => {
    expect(usageRingFor(usage("claude", 0, 0), undefined, NOW)).toEqual({ level: 100, tone: "good" });
    expect(usageRingFor(usage("claude", 30, 10), undefined, NOW)).toEqual({ level: 70, tone: "good" });
    expect(usageRingFor(usage("claude", 20, 60), undefined, NOW)).toEqual({ level: 40, tone: "caution" });
    expect(usageRingFor(usage("claude", 80, 30), undefined, NOW)).toEqual({ level: 20, tone: "warning" });
    expect(usageRingFor(usage("claude", 20, 95), undefined, NOW)).toEqual({ level: 5, tone: "danger" });
    const rest = { since: new Date(NOW - 1_200_000).toISOString(), until: new Date(NOW + 3_600_000).toISOString() };
    expect(usageRingFor(usage("claude", 20, 30), rest, NOW)).toEqual({ level: 25, tone: "accent", charging: true });
    expect(usageRingFor(usage("claude", 20, 30), { until: rest.until }, NOW)).toEqual({ level: null, tone: "accent", charging: true });
    expect(usageRingFor(undefined, undefined, NOW)).toBeNull();
    expect(usageRingFor({ ...usage("claude", 20, 30), ok: false }, undefined, NOW)).toBeNull();
  });

  it("draws the remaining battery and empties at zero", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(UsageRing, { level: 40, tone: "accent", children: createElement("i") })));
    expect(container.querySelector("[data-usage-ring]")!.getAttribute("data-usage-ring")).toBe("40");
    expect(container.querySelectorAll("circle")).toHaveLength(2);
    expect(container.querySelectorAll("circle")[1].getAttribute("class")).toBe("text-accent");
    await act(async () => root!.render(createElement(UsageRing, { level: 0, tone: "accent", children: createElement("i") })));
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });
});

describe("an account's initials", () => {
  it("takes the first letter of up to two words in any script, and never comes back empty", () => {
    expect(accountInitials("Personal")).toBe("P");
    expect(accountInitials("work plan")).toBe("WP");
    expect(accountInitials("  Ada   Lovelace  Byron ")).toBe("AL");
    expect(accountInitials("émile zola")).toBe("ÉZ");
    expect(accountInitials("🐶 Dog")).toBe("🐶D");
    expect(accountInitials("   ")).toBe("?");
  });

  it("wears them on a small badge beside the provider's mark, which sits inside the usage ring when there is one", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(createElement(AccountBadge, { instance: work, ring: null })));
    expect(container.querySelector("[data-account-initials]")!.getAttribute("data-account-initials")).toBe("W");
    expect(container.querySelector("[data-usage-ring]")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    await act(async () => root!.render(createElement(AccountBadge, { instance: work, ring: { level: 40, tone: "accent" } })));
    expect(container.querySelector("[data-usage-ring]")!.getAttribute("data-usage-ring")).toBe("40");
    expect(container.querySelector("[data-usage-ring]")!.children).toHaveLength(2);
    expect(container.querySelector("[data-usage-ring]")!.textContent).not.toContain("W");
    expect(container.querySelector("[data-account-initials]")!.textContent).toBe("W");
    await act(async () => root!.render(createElement(AccountBadge, { instance: work, ring: usageRingFor(usage("claude-work", 100, 20), undefined, NOW) })));
    expect(container.querySelector("[data-sleeping-dog]")).not.toBeNull();
    expect(container.querySelector("[data-charging]")).toBeNull();
  });
});
