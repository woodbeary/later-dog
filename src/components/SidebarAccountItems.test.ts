// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import type { PlanProvider } from "./PlanUsage";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const fixture = vi.hoisted(() => ({
  instances: [] as InstanceInfo[],
  bots: [] as Bot[],
  battery: undefined as unknown,
  providers: [] as PlanProvider[],
  dispatch: vi.fn(),
  add: vi.fn(),
}));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: { ...original.initialState, instances: fixture.instances, bots: fixture.bots, selectedId: "scout", config: { accountBattery: fixture.battery } },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("./PlanUsage", async (importOriginal) => {
  const original = await importOriginal<typeof import("./PlanUsage")>();
  return { ...original, usePlanUsage: () => ({ report: { fetchedAt: new Date(NOW).toISOString(), providers: fixture.providers }, loading: false, error: "", now: NOW, reload: vi.fn() }) };
});
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/add-account-request", () => ({ requestAddAccount: () => fixture.add() }));

import { useAccountMenuItems, weeklyUsed } from "./SidebarAccountItems";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

const claude = (instanceId: string, displayName: string, email: string): InstanceInfo => ({
  instanceId, driverKind: "claudeAgent", displayName, access: "subscription",
  snapshot: { state: "available", authenticated: true, account: { email, method: "login" } },
  models: { default: "opus", options: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] },
});
const codex: InstanceInfo = {
  instanceId: "chatgpt", driverKind: "codex", displayName: "ChatGPT plan", access: "subscription",
  snapshot: { state: "available", authenticated: true, chatgptPlan: true },
  models: { default: "gpt", options: [{ id: "gpt", label: "GPT" }] },
};
const win = (used: number, minutes: number) => ({ available: true, usedPercent: used, remainingPercent: 100 - used, resetsAt: new Date(NOW + minutes * 60_000).toISOString() });
const provider = (id: string, five: number, week: number): PlanProvider => ({ id, name: id, driver: "claude", plan: "Max", ok: true, error: null, extra: [], fiveHour: win(five, 190), weekly: win(week, 5000) });
const scout = (instanceId: string, approvalMode?: string): Bot => ({
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId, model: "opus" }, ...(approvalMode ? { approvalMode } : {}),
} as Bot);

function items() {
  let captured: ReturnType<typeof useAccountMenuItems> | null = null;
  function Capture() {
    captured = useAccountMenuItems();
    return null;
  }
  renderToStaticMarkup(createElement(Capture));
  return captured!;
}
const markup = (node: SidebarMenuItem["submenu"], close = vi.fn()) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement("div", null, typeof node === "function" ? node(close) as ReactNode : node));
  return host;
};

beforeEach(() => {
  fixture.instances = [claude("claude", "Jacob", "jacob@txtclaw.com"), claude("claude-b", "Work", "jacob@work.dev"), codex];
  fixture.bots = [scout("claude")];
  fixture.battery = { enabled: true, auto: false, order: {}, resting: {} };
  fixture.providers = [provider("claude", 38, 22), provider("claude-b", 100, 64), provider("chatgpt", 12, 31)];
  fixture.dispatch.mockReset();
  fixture.add.mockReset();
});

describe("the account rows in the menu under your name", () => {
  it("shows the weekly amount left for the account in use and opens its reset times on hover", () => {
    const { usage } = items();
    expect(usage).toMatchObject({ key: "account-usage", label: "Max · Weekly" });
    const html = markup(usage!.trailing as ReactNode);
    expect(html.textContent).toBe("78% left");
    const close = vi.fn();
    const card = markup(usage!.submenu, close);
    expect(card.querySelector('[data-usage-window="fiveHour"]')?.textContent).toContain("resets in 3h 10m");
    expect(card.querySelector('[data-usage-window="weekly"]')?.textContent).toContain("resets in 3d 11h");
    card.querySelector<HTMLElement>("[data-account-manage-usage]");
    expect(card.querySelector("[data-account-manage-usage]")?.textContent).toBe("Manage usage");
  });

  it("opens Settings at Usage and closes the menu from Manage usage", async () => {
    const { usage } = items();
    const close = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(host);
    await act(async () => root.render(createElement("div", null, (usage!.submenu as (close: () => void) => ReactNode)(close))));
    await act(async () => host.querySelector<HTMLElement>("[data-account-manage-usage]")!.click());
    expect(close).toHaveBeenCalledOnce();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "usage" });
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("says when the account in use is back instead of a percentage", () => {
    fixture.battery = { enabled: true, auto: false, order: {}, resting: { claude: { since: new Date(NOW - 3_600_000).toISOString(), until: new Date(NOW + 3_600_000).toISOString() } } };
    const { usage } = items();
    expect(usage!.label).toBe("Jacob");
    expect(markup(usage!.trailing as ReactNode).textContent).toMatch(/^Back at /);
  });

  it("lists every account with its initials, battery and a check on the one in use, then Add account", () => {
    const { accounts } = items();
    expect(accounts).toMatchObject({ key: "switch-account", label: "Switch account", separatorBefore: true });
    const list = markup(accounts!.submenu);
    const rows = [...list.querySelectorAll<HTMLElement>("[data-switch-account]")];
    expect(rows.map((row) => row.getAttribute("data-switch-account"))).toEqual(["claude", "claude-b", "chatgpt"]);
    expect(rows[0]!.textContent).toContain("J");
    expect(rows[0]!.textContent).toContain("jacob@txtclaw.com");
    expect(rows[0]!.getAttribute("aria-checked")).toBe("true");
    expect(rows[1]!.getAttribute("aria-checked")).toBe("false");
    expect(rows[1]!.querySelector("[data-battery]")?.getAttribute("data-battery")).toBe("0");
    expect(list.querySelector("[data-switch-add]")?.textContent).toBe("Add account");
  });

  it("keeps a resting account's name ahead of its back-at time", () => {
    fixture.battery = { enabled: true, auto: false, order: {}, resting: { "claude-b": { since: new Date(NOW - 3_600_000).toISOString(), until: new Date(NOW + 3 * 86_400_000).toISOString() } } };
    const row = markup(items().accounts!.submenu).querySelector<HTMLElement>('[data-switch-account="claude-b"]')!;
    expect(row.querySelector("[data-switch-account-name]")!.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-auto"]));
    const charge = row.querySelector('[data-account-charge="recharging"]')!;
    expect(charge.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "shrink-[1000]"]));
    const back = charge.lastElementChild!;
    expect(back.textContent).toMatch(/^Back at /);
    expect(back.getAttribute("title")).toBe(back.textContent);
    expect(back.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
  });

  it("switches an account of the same engine and keeps the model if the account has it", async () => {
    const { accounts } = items();
    const close = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(host);
    await act(async () => root.render(createElement("div", null, (accounts!.submenu as (close: () => void) => ReactNode)(close))));
    await act(async () => host.querySelector<HTMLElement>('[data-switch-account="claude-b"]')!.click());
    expect(close).toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "setModel", botId: "scout", threadId: "thread-scout",
      selection: expect.objectContaining({ instanceId: "claude-b", model: "opus" }),
    }));
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("leaves a switch to another engine to the chat's account button when it needs a question first", () => {
    fixture.bots = [scout("claude", "full")];
    const list = markup(items().accounts!.submenu);
    const chatgpt = list.querySelector<HTMLButtonElement>('[data-switch-account="chatgpt"]')!;
    expect(chatgpt.disabled).toBe(true);
    expect(chatgpt.title).toContain("account button in the chat");
    expect(list.querySelector<HTMLButtonElement>('[data-switch-account="claude-b"]')!.disabled).toBe(false);
  });

  it("offers nothing to switch to with one account, and nothing at all with none", () => {
    fixture.instances = [claude("claude", "Jacob", "jacob@txtclaw.com")];
    const one = items();
    expect(one.accounts).toBeNull();
    expect(one.add).toMatchObject({ key: "add-account", label: "Add account" });
    one.add!.onSelect();
    expect(fixture.add).toHaveBeenCalledOnce();
    fixture.instances = [];
    expect(items()).toEqual({ usage: null, accounts: null, add: null });
  });

  it("takes the weekly window, or the tighter one when the weekly is not reported", () => {
    expect(weeklyUsed(provider("a", 80, 22))).toBe(22);
    expect(weeklyUsed({ ...provider("a", 80, 22), weekly: { available: false, usedPercent: null, remainingPercent: null, resetsAt: null } })).toBe(80);
    expect(weeklyUsed(undefined)).toBeNull();
  });
});
