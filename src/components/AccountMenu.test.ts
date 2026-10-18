// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { ACCOUNT_MENU_WIDTH, AccountMenu, activeRowId, restStatus, type AccountMenuRow } from "./AccountMenu";
import type { PlanProvider } from "./PlanUsage";
const now = Date.parse("2026-10-13T12:00:00Z");
const instance = (instanceId: string): InstanceInfo => ({ instanceId, displayName: instanceId, driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true }, models: { default: "opus", options: [] } });
const provider: PlanProvider = { id: "a", name: "a", driver: "claude", plan: null, ok: true, error: null, extra: [], fiveHour: { available: true, usedPercent: 16, remainingPercent: 84, resetsAt: null }, weekly: { available: true, usedPercent: 27, remainingPercent: 73, resetsAt: null } };
const rest = { since: new Date(now - 3_600_000).toISOString(), until: new Date(now + 3_600_000).toISOString() };
function render(auto = false, used = 27) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(AccountMenu, { auto, now, onPick: vi.fn(), rows: [
    { instance: instance("a"), label: "Personal", selected: true, rest },
    { instance: instance("b"), label: "Work", selected: false, inUse: true, provider: { ...provider, weekly: { ...provider.weekly, usedPercent: used, remainingPercent: 100 - used } } },
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
      for (const column of ["[data-account-battery-column]", "[data-account-value-column]", "[data-account-check]"]) expect(row.querySelector(column)).not.toBeNull();
    }
    expect(host.querySelector('[data-account-row="a"] [data-account-status]')).not.toBeNull();
    expect(host.querySelector('[data-account-row="b"] [data-account-status]')).toBeNull();
    const bare = document.createElement("div");
    bare.innerHTML = renderToStaticMarkup(createElement(AccountMenu, { now, onPick: vi.fn(), rows: [{ instance: instance("z"), label: "Z", selected: false }] }));
    expect(bare.querySelector("[data-account-battery-column]")?.className).toContain("w-8");
    expect(bare.querySelector("[data-battery]")).toBeNull();
  });
  it("shows how far a resting account has recharged as a number that fits its column", () => {
    const value = render().querySelector('[data-account-row="a"] [data-account-value-column]')!;
    expect(value.textContent).toBe("50%");
    expect(value.getAttribute("title")).toBe("50% recharged");
    expect(value.className).toContain("w-10");
  });
  it("sleeps at a verified full limit without a fabricated recharge estimate", () => {
    const row = render(false, 100).querySelector('[data-account-row="b"]')!;
    expect(row.querySelector("[data-sleeping-dog]")).not.toBeNull();
    expect(row.textContent).toContain("0%");
    expect(row.querySelector("[data-recharge]")).toBeNull();
    expect(render(false, 99.6).querySelector('[data-account-row="b"] [data-sleeping-dog]')).toBeNull();
  });
  it("says when the server manages priority, with nothing to drag", () => {
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

describe("account names come first", () => {
  const LIST_CHROME = 2 + 8;
  const NAME_MINIMUM = 128;
  const usage = (id: string, used: number): PlanProvider => ({ ...provider, id, weekly: { ...provider.weekly, usedPercent: used, remainingPercent: 100 - used } });
  const kinds = (instanceId: string, driverKind: string): InstanceInfo => ({ ...instance(instanceId), driverKind });
  const jacobs: AccountMenuRow[] = [
    { instance: kinds("claude", "claudeAgent"), label: "Claude", selected: true, inUse: true, provider: usage("claude", 0) },
    { instance: kinds("claude-2", "claudeAgent"), label: "jacob.lopez.work.account@example.com", selected: false, rest },
    { instance: kinds("claude-3", "claudeAgent"), label: "A very long Claude account name for the team", selected: false, provider: usage("claude-3", 64) },
    { instance: kinds("codex", "codex"), label: "ChatGPT", selected: false, provider: usage("codex", 0) },
    { instance: kinds("laterdogAi", "laterdogAi"), label: "Kimi", selected: false },
    { instance: kinds("grok", "grokAgent"), label: "Grok", selected: false },
  ];
  const draw = (rows: readonly AccountMenuRow[]) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(AccountMenu, { now, onPick: vi.fn(), onAdd: vi.fn(), rows }));
    return host;
  };
  const fixedWidth = (element: Element) => {
    const match = /(?:^|\s)(?:w|size)-(\d+(?:\.\d+)?)(?:\s|$)/.exec(element.getAttribute("class") ?? "");
    if (!match) throw new Error(`no fixed width on ${element.outerHTML.slice(0, 120)}`);
    return Number(match[1]) * 4;
  };

  it("writes every account's name in its row", () => {
    const host = draw(jacobs);
    for (const row of jacobs) {
      const label = host.querySelector(`[data-account-row="${row.instance.instanceId}"] [data-account-label]`)!;
      expect(label.textContent).toBe(row.label);
      expect(label.getAttribute("title")).toBe(row.label);
    }
  });

  it("lets the name take its own width and shrink last, with the status beside it only when it fits", () => {
    const row = draw(jacobs).querySelector('[data-account-row="claude-2"]')!;
    const line = row.querySelector("[data-account-name-line]")!;
    const label = line.querySelector("[data-account-label]")!;
    const status = line.querySelector("[data-account-status]")!;
    expect(line.parentElement).toBe(row);
    expect(line.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-auto", "flex-wrap", "content-start", "overflow-hidden", "h-[1lh]"]));
    expect(label.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-auto", "truncate"]));
    expect(label.className).not.toMatch(/(?:^|\s)(?:flex-1|w-\d|basis-0)/);
    expect(label.nextElementSibling).toBe(status);
    expect(status.className.split(" ")).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
    expect(status.className).not.toMatch(/(?:^|\s)w-\d/);
    expect(status.textContent).toMatch(/^Back at /);
  });

  it("leaves the name at least 8rem beside fixed, aligned columns at the menu's width", () => {
    const host = draw(jacobs);
    const widths = new Set<number>();
    for (const row of jacobs) {
      const button = host.querySelector(`[data-account-row="${row.instance.instanceId}"]`)!;
      const columns = [...button.children].filter((child) => !child.hasAttribute("data-account-name-line"));
      for (const column of columns) expect(column.className).toContain("shrink-0");
      const fixed = columns.reduce((sum, column) => sum + fixedWidth(column), 0);
      const gaps = (button.children.length - 1) * 10;
      const padding = 10 + (button.className.split(" ").includes("pr-1") ? 4 : 10);
      widths.add(fixed);
      expect(ACCOUNT_MENU_WIDTH - LIST_CHROME - padding - fixed - gaps).toBeGreaterThanOrEqual(NAME_MINIMUM);
    }
    expect(widths.size).toBe(1);
  });
});
