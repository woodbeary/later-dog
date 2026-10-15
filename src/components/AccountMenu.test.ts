// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { AccountMenu, activeRowId, restStatus } from "./AccountMenu";
import type { PlanProvider } from "./PlanUsage";
const now = Date.parse("2026-10-13T12:00:00Z");
const instance = (instanceId: string): InstanceInfo => ({ instanceId, displayName: instanceId, driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true }, models: { default: "opus", options: [] } });
const provider: PlanProvider = { id: "a", name: "a", driver: "claude", plan: null, ok: true, error: null, extra: [], fiveHour: { available: true, usedPercent: 16, remainingPercent: 84, resetsAt: null }, weekly: { available: true, usedPercent: 27, remainingPercent: 73, resetsAt: null } };
const rest = { since: new Date(now - 3_600_000).toISOString(), until: new Date(now + 3_600_000).toISOString() };
function render(auto = false, used = 27) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(AccountMenu, { auto, now, onPick: vi.fn(), onReorder: vi.fn(), rows: [
    { instance: instance("a"), label: "Personal", selected: true, movable: true, rest },
    { instance: instance("b"), label: "Work", selected: false, movable: true, inUse: true, provider: { ...provider, weekly: { ...provider.weekly, usedPercent: used, remainingPercent: 100 - used } } },
  ] }));
  return host;
}
describe("compact account batteries", () => {
  it("replaces the resting provider mark with a dog and a filling battery", () => {
    const row = render().querySelector('[data-account-row="a"]')!;
    expect(row.firstElementChild?.firstElementChild?.hasAttribute("data-sleeping-dog")).toBe(true);
    expect(row.querySelector('[data-recharge="50"]')).not.toBeNull();
    expect(row.textContent).toContain("Resting · back at");
    expect(row.querySelector("[data-charging-bolt]")).not.toBeNull();
    expect(row.querySelector("[data-account-check]")?.getAttribute("data-account-check")).toBe("off");
    expect(row.querySelector("[data-account-grip]")?.className).not.toContain("opacity-0");
  });
  it("shows the tighter remaining window and identifies the account actually in use", () => {
    const row = render().querySelector('[data-account-row="b"]')!;
    expect(row.textContent).toContain("73%");
    expect(row.querySelector("[data-account-check=on] svg")).not.toBeNull();
    expect(row.textContent).not.toContain("In use now");
    expect(row.querySelector("[data-charging-bolt]")).toBeNull();
  });
  it("puts the check on the row in use, else on the selected row", () => {
    const rows = [
      { instance: instance("a"), label: "A", selected: true },
      { instance: instance("b"), label: "B", selected: false, inUse: true },
    ];
    expect(activeRowId(rows)).toBe("b");
    expect(activeRowId(rows.map((row) => ({ ...row, inUse: false })))).toBe("a");
    expect(activeRowId([{ instance: instance("c"), label: "C", selected: false }])).toBeUndefined();
  });
  it("labels a resting row Resting only when selected", () => {
    expect(restStatus(rest, true, now)).toMatch(/^Resting · back at /);
    expect(restStatus(rest, false, now)).toMatch(/^Back at /);
    expect(restStatus({ ...rest, estimated: true }, true, now)).toBe("Recharging");
  });
  it("keeps every column on every row so batteries and numbers line up", () => {
    const host = render();
    for (const id of ["a", "b"]) {
      const row = host.querySelector(`[data-account-row="${id}"]`)!;
      for (const column of ["[data-account-status]", "[data-account-battery-column]", "[data-account-value-column]", "[data-account-check]"]) expect(row.querySelector(column)).not.toBeNull();
    }
    const bare = document.createElement("div");
    bare.innerHTML = renderToStaticMarkup(createElement(AccountMenu, { now, onPick: vi.fn(), rows: [{ instance: instance("z"), label: "Z", selected: false }] }));
    expect(bare.querySelector("[data-account-battery-column]")?.className).toContain("w-8");
    expect(bare.querySelector("[data-battery]")).toBeNull();
  });
  it("sleeps at a verified full limit without a fabricated recharge estimate", () => {
    const row = render(false, 100).querySelector('[data-account-row="b"]')!;
    expect(row.querySelector("[data-sleeping-dog]")).not.toBeNull();
    expect(row.textContent).toContain("0%");
    expect(row.querySelector("[data-recharge]")).toBeNull();
    expect(render(false, 99.6).querySelector('[data-account-row="b"] [data-sleeping-dog]')).toBeNull();
  });
  it("locks dragging while the server manages priority", () => {
    const host = render(true);
    expect(host.querySelector("[data-account-managed]")?.textContent).toContain("Automatically managed");
    expect(host.querySelector("[data-account-grip]")).toBeNull();
    expect(host.querySelector("[draggable]")).toBeNull();
  });
});

describe("account menu details", () => {
  const stamp = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const detailed: PlanProvider = { ...provider, plan: "Max", fiveHour: { available: true, usedPercent: 38, remainingPercent: 62, resetsAt: stamp(190) }, weekly: { available: true, usedPercent: 22, remainingPercent: 78, resetsAt: stamp(5000) } };
  async function mount(manage = vi.fn(), extra: readonly { instance: InstanceInfo; label: string; selected: boolean; provider?: PlanProvider }[] = []) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(AccountMenu, { now, onPick: vi.fn(), onManageUsage: manage, rows: [
      { instance: instance("a"), label: "Personal", selected: true, provider: detailed },
      ...extra,
    ] })));
    return { host, root };
  }

  it("draws a battery that holds what is left, with the number beside it", async () => {
    const { host, root } = await mount();
    const row = host.querySelector('[data-account-row="a"]')!;
    expect(row.querySelector("[data-battery]")?.getAttribute("data-battery")).toBe("62");
    expect(row.querySelector("[data-account-charge]")?.textContent).toBe("62%");
    await act(async () => root.unmount());
    host.remove();
  });

  it("opens the usage card when the row is reached, with both reset times and Manage usage", async () => {
    const manage = vi.fn();
    const { host, root } = await mount(manage);
    expect(host.querySelector("[data-account-hover-card]")).toBeNull();
    await act(async () => host.querySelector('[data-account-row="a"]')!.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    const card = host.querySelector("[data-account-hover-card]")!;
    expect(card.textContent).toContain("Max");
    expect(card.querySelector('[data-usage-window="fiveHour"]')?.textContent).toContain("resets in 3h 10m");
    expect(card.querySelector('[data-usage-window="weekly"]')?.textContent).toContain("78%");
    expect(card.querySelector('[data-usage-window="weekly"] [data-usage-reset]')?.textContent).toContain("resets in 3d 11h");
    await act(async () => card.querySelector<HTMLElement>("[data-account-manage-usage]")!.click());
    expect(manage).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    host.remove();
  });

  it("opens the usage card on hover after a short pause and closes it after the pointer leaves", async () => {
    vi.useFakeTimers();
    try {
      const { host, root } = await mount();
      const row = host.querySelector('[data-account-row="a"]')!.parentElement!;
      await act(async () => { row.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); });
      expect(host.querySelector("[data-account-hover-card]")).toBeNull();
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(host.querySelector("[data-account-hover-card]")).not.toBeNull();
      await act(async () => { row.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })); vi.advanceTimersByTime(300); });
      expect(host.querySelector("[data-account-hover-card]")).toBeNull();
      await act(async () => root.unmount());
      host.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists an account once even when two groups hand it over", async () => {
    const twin = { instance: instance("a"), label: "Personal", selected: true, provider: detailed };
    const { host, root } = await mount(vi.fn(), [twin]);
    expect(host.querySelectorAll('[data-account-row="a"]')).toHaveLength(1);
    await act(async () => root.unmount());
    host.remove();
  });
});
