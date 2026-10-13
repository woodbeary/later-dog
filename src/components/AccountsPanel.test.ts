// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import type { PlanProvider } from "./PlanUsage";

type State = { config: Pick<ConfigStatus, "accountBattery">; instances: InstanceInfo[] };
type SignInProps = { instanceId: string; autoStart?: boolean; compact?: boolean; browserPkce?: boolean; onSignedIn?: () => void; onCancelled?: () => void };
type Report = { providers: Array<Partial<PlanProvider> & { id: string }> };

const fixture = vi.hoisted(() => ({
  state: { config: {}, instances: [] } as unknown as State,
  listeners: new Set<() => void>(),
  api: vi.fn(),
  signIns: [] as Array<{ kind: "claude" | "device"; props: SignInProps }>,
  report: null as Report | null,
  loading: false,
  reload: vi.fn(),
  refreshInstances: vi.fn(),
}));
function publish(next: Partial<State>) {
  fixture.state = { ...fixture.state, ...next };
  for (const listener of fixture.listeners) listener();
}

vi.mock("@/state/store", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    fixture.listeners.add(listener);
    return () => { fixture.listeners.delete(listener); };
  };
  const dispatch = (action: { type: string; config?: ConfigStatus; instances?: InstanceInfo[] }) => {
    if (action.type === "configStatus") publish({ config: action.config! });
    if (action.type === "instances") publish({ instances: action.instances! });
  };
  return {
    api: fixture.api,
    useStore: () => ({ state: useSyncExternalStore(subscribe, () => fixture.state), dispatch, refreshInstances: fixture.refreshInstances }),
  };
});
vi.mock("./PlanUsage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./PlanUsage")>()),
  usePlanUsage: () => ({ report: fixture.report, loading: fixture.loading, error: "", now: Date.now(), reload: fixture.reload }),
}));
vi.mock("./ClaudeSignIn", () => ({
  ClaudeSignIn: (props: SignInProps) => {
    fixture.signIns.push({ kind: "claude", props });
    return createElement("div", { "data-sign-in": "claude" });
  },
}));
vi.mock("./DeviceSignIn", () => ({
  DeviceSignIn: (props: SignInProps) => {
    fixture.signIns.push({ kind: "device", props });
    return createElement("div", { "data-sign-in": "device" });
  },
}));

const { AccountsPanel, AccountsRefresh, accountOrder, pollSignedIn, realAccount, removable, shownOrder, subscriptionAccounts, useCarryOn } = await import("./AccountsPanel");
const { requestAddAccount } = await import("@/lib/add-account-request");
const { AddAccountHost } = await import("./AddAccountHost");
const Settings = () => createElement(Fragment, null, createElement(AccountsRefresh), createElement(AccountsPanel), createElement(AddAccountHost));

const claude = (instanceId: string, displayName: string, snapshot: Partial<InstanceInfo["snapshot"]> = {}): InstanceInfo => ({
  instanceId, driverKind: "claudeAgent", displayName, access: "subscription",
  snapshot: { state: "available", authenticated: true, ...snapshot },
  models: { default: "claude-sonnet-5", options: [] },
  authentication: { method: "paste-code", signOut: true },
  claudeAccount: { configDir: `/fixture/${instanceId}`, signInCommand: "claude auth login", signInShell: "sh", isDefault: instanceId === "claude" },
});
const chatgpt = (instanceId: string, displayName: string, snapshot: Partial<InstanceInfo["snapshot"]> = {}): InstanceInfo => ({
  instanceId, driverKind: "codex", displayName, access: "subscription",
  snapshot: { state: "available", authenticated: true, chatgptPlan: true, ...snapshot },
  models: { default: "gpt-5", options: [] },
  authentication: { method: "browser-pkce", signOut: true },
});
const codexLogin = (snapshot: Partial<InstanceInfo["snapshot"]> = {}): InstanceInfo => ({
  instanceId: "codex", driverKind: "codex", displayName: "Codex", access: "subscription",
  snapshot: { state: "available", authenticated: true, ...snapshot },
  models: { default: "gpt-5", options: [] },
  authentication: { method: "device-code", signOut: true },
});
const claudeApi = (): InstanceInfo => ({ ...claude("claudeApi", "Claude API", { account: { method: "api-key" } }), access: "api" });
const signedInAs = (instanceId: string, email: string) => fixture.state.instances.map((item) =>
  item.instanceId === instanceId ? { ...item, snapshot: { ...item.snapshot, state: "available" as const, authenticated: true, account: { email } } } : item);
const signedOut = (instanceId: string) => fixture.state.instances.map((item) =>
  item.instanceId === instanceId ? { ...item, snapshot: { ...item.snapshot, authenticated: false, account: undefined } } : item);
const usage = (id: string, used: number | null, plan: string | null = "Max"): PlanProvider => ({
  id, name: id, driver: "claude", plan, ok: true, error: null, extra: [],
  fiveHour: {
    available: used !== null, remainingPercent: used === null ? null : 100 - used, usedPercent: used,
    resetsAt: used === null ? null : new Date(Date.now() + 2 * 3_600_000 + 30_000).toISOString(),
  },
  weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null },
});
const unchecked = (id: string): PlanProvider => ({ ...usage(id, null, null), ok: false, error: "Rate limited" });

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
const all = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
const ids = () => all("[data-account]").map((element) => element.dataset.account);
const button = (label: string, within: ParentNode = document.body) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);
const row = (instanceId: string) => document.body.querySelector<HTMLElement>(`[data-account="${instanceId}"]`);
const box = (instanceId: string) => row(instanceId)!.querySelector<HTMLElement>("[data-account-row]")!;
const line = (instanceId: string) => row(instanceId)?.querySelector("p")?.textContent;
const rowButtons = (instanceId: string) => [...row(instanceId)!.querySelectorAll("button:not([aria-label])")].map((element) => element.textContent?.trim());
const removeButton = (name: string) => document.body.querySelector<HTMLButtonElement>(`[data-accounts-panel] button[aria-label="Remove ${name}"]`);
const usageOf = (instanceId: string) => row(instanceId)?.querySelector<HTMLElement>("[data-account-usage]") ?? null;
const empty = () => document.body.querySelector<HTMLElement>("[data-accounts-empty]");
const panelText = () => document.body.querySelector("[data-accounts-panel]")!.textContent ?? "";
const sheet = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
const toggle = () => document.body.querySelector<HTMLButtonElement>('[data-accounts-panel] [role="switch"]')!;
const click = async (element: HTMLElement | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => element!.click());
  await settle();
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = async (target: HTMLElement, key: string) => {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  await settle();
};
const lastSignIn = () => fixture.signIns.at(-1)!;
const remount = async (next: Partial<State>) => {
  await act(async () => root.unmount());
  fixture.state = { ...fixture.state, ...next };
  root = createRoot(host);
  await act(async () => root.render(createElement(Settings)));
};

beforeEach(async () => {
  setLocale("en");
  fixture.listeners.clear();
  fixture.signIns = [];
  fixture.loading = false;
  fixture.report = { providers: [{ id: "claude", plan: "Max" }, { id: "chatgpt", plan: "Plus" }] };
  fixture.state = {
    instances: [
      claude("claude", "Personal", { account: { email: "me@example.test" } }),
      claude("claude-work", "Work", { authenticated: false }),
      chatgpt("chatgpt", "ChatGPT", { account: { email: "me@openai.test" } }),
      claudeApi(),
    ],
    config: { accountBattery: { enabled: false, order: { claudeAgent: ["claude", "claude-work"], codex: ["chatgpt"] }, resting: {} } },
  };
  fixture.api.mockReset();
  fixture.reload.mockReset().mockResolvedValue(undefined);
  fixture.refreshInstances.mockReset().mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Settings)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("account refresh", () => {
  it("refreshes usage, sign-ins and cooldowns together and accepts the new config", async () => {
    fixture.api.mockResolvedValueOnce({ accountBattery: { enabled: true, order: {}, resting: {} } });
    await click(document.body.querySelector<HTMLButtonElement>("[data-accounts-refresh]"));
    expect(fixture.reload).toHaveBeenCalledWith(true);
    expect(fixture.refreshInstances).toHaveBeenCalledOnce();
    expect(fixture.api).toHaveBeenCalledWith("/api/config");
    expect(fixture.state.config.accountBattery?.enabled).toBe(true);
    expect(document.body.querySelector<HTMLButtonElement>("[data-accounts-refresh]")?.disabled).toBe(false);
  });

  it("allows another refresh after one source fails", async () => {
    fixture.api.mockRejectedValueOnce(new Error("offline"));
    fixture.refreshInstances.mockRejectedValueOnce(new Error("offline"));
    await click(document.body.querySelector<HTMLButtonElement>("[data-accounts-refresh]"));
    expect(fixture.reload).toHaveBeenCalledWith(true);
    expect(document.body.querySelector<HTMLButtonElement>("[data-accounts-refresh]")?.disabled).toBe(false);
  });
});

describe("account helpers", () => {
  it("lists personal subscription accounts in the battery's order, and nothing an API key, a company or a policy owns", () => {
    const { instances, config } = fixture.state;
    expect(subscriptionAccounts(instances, config.accountBattery).map((item) => item.instanceId)).toEqual(["claude", "claude-work", "chatgpt"]);
    const more = [
      ...instances,
      claude("claude-new", "New"),
      claude("claude-key", "Key", { account: { method: "api-key" } }),
      { ...claude("company.claude", "Company"), readOnly: true, managed: { organizationId: "org", organizationName: "Org" } },
      { ...chatgpt("chatgpt-blocked", "Blocked"), policy: { organizationName: "Org", reason: "Not allowed" } },
      { ...chatgpt("openrouter", "Router"), access: "api" as const },
    ];
    expect(subscriptionAccounts(more, { order: { claudeAgent: ["claude-work", "claudeApi", "claude-key", "claude"], codex: ["chatgpt-blocked"] } }).map((item) => item.instanceId))
      .toEqual(["claude-work", "claude", "claude-new", "chatgpt"]);
    expect(subscriptionAccounts(instances, undefined).map((item) => item.instanceId)).toEqual(["claude", "claude-work", "chatgpt"]);
  });

  it("keeps the first account of each engine, and saves the shown order per engine", () => {
    const rows = subscriptionAccounts(fixture.state.instances, fixture.state.config.accountBattery);
    expect(rows.map(removable)).toEqual([false, true, false]);
    expect(removable(chatgpt("chatgpt-work", "Work"))).toBe(true);
    expect(removable(chatgpt("codex", "Codex"))).toBe(false);
    expect(accountOrder(rows)).toEqual({ claudeAgent: ["claude", "claude-work"], codex: ["chatgpt"] });
  });

  it("counts an account as real once it is signed in or was added, and a built-in one nobody signed in to as not", () => {
    expect(realAccount(claude("claude", "Claude"))).toBe(true);
    expect(realAccount(claude("claude", "Claude", { authenticated: false }))).toBe(false);
    expect(realAccount(claude("claude", "Claude", { state: "unavailable" }))).toBe(false);
    expect(realAccount(codexLogin({ authenticated: false }))).toBe(false);
    expect(realAccount(chatgpt("chatgpt", "ChatGPT plan", { authenticated: false }))).toBe(false);
    expect(realAccount(claude("claude-work", "Work", { authenticated: false }))).toBe(true);
    expect(realAccount(chatgpt("chatgpt-team", "Team", { authenticated: false }))).toBe(true);
  });

  it("hides a leftover Codex login nobody signed in to, and keeps it once it is signed in", () => {
    const leftover = { ...codexLogin({ authenticated: false }), instanceId: "codex-2", displayName: "Codex 2" };
    expect(removable(leftover)).toBe(true);
    expect(realAccount(leftover)).toBe(false);
    expect(realAccount({ ...leftover, snapshot: { ...leftover.snapshot, authenticated: true } })).toBe(true);
  });

  it("puts the shown accounts in their new order and leaves a hidden one where it was", () => {
    const rows = [claude("claude", "Personal"), claude("claude-old", "Old", { authenticated: false }), claude("claude-work", "Work"), chatgpt("chatgpt", "ChatGPT")];
    expect(shownOrder(rows, ["claude-work", "claude", "chatgpt"])).toEqual({ claudeAgent: ["claude-work", "claude-old", "claude"], codex: ["chatgpt"] });
    expect(shownOrder(rows, ["chatgpt"])).toEqual({ claudeAgent: ["claude", "claude-old", "claude-work"], codex: ["chatgpt"] });
  });

  it("checks the fetched list after each wait until the account reads as signed in", async () => {
    const fetchSignedIn = vi.fn(async () => fetchSignedIn.mock.calls.length === 2);
    await expect(pollSignedIn(() => false, fetchSignedIn, [0, 0, 0, 0])).resolves.toBe(true);
    expect(fetchSignedIn).toHaveBeenCalledTimes(2);
    fetchSignedIn.mockClear();
    await expect(pollSignedIn(() => true, fetchSignedIn, [0])).resolves.toBe(true);
    expect(fetchSignedIn).not.toHaveBeenCalled();
    const never = vi.fn(async () => false);
    await expect(pollSignedIn(() => false, never, [0, 0, 0])).resolves.toBe(false);
    expect(never).toHaveBeenCalledTimes(3);
  });
});

describe("Accounts", () => {
  it("lists only the account someone really has: no Codex or ChatGPT plan row they never added, and no usage error", async () => {
    fixture.report = { providers: [unchecked("claude")] };
    await remount({ instances: [
      claude("claude", "Claude"),
      codexLogin({ authenticated: false }),
      chatgpt("chatgpt", "ChatGPT plan", { authenticated: false }),
      claudeApi(),
    ] });
    expect(ids()).toEqual(["claude"]);
    expect(line("claude")).toBe("Signed in");
    expect(rowButtons("claude")).toEqual([]);
    expect(removeButton("Claude")).not.toBeNull();
    expect(usageOf("claude")).toBeNull();
    for (const noise of ["Codex", "ChatGPT plan", "Not signed in", "Couldn't check usage", "Checking usage", "No usage reported yet", "Sign out"]) {
      expect(panelText()).not.toContain(noise);
    }
    expect(button("Add account")).toBeDefined();
    expect(panelText()).not.toContain("Keep going when an account runs out");
  });

  it("shows nothing but the way to add one when no account is signed in", async () => {
    await remount({ instances: [
      claude("claude", "Claude", { authenticated: false }),
      codexLogin({ state: "unavailable", authenticated: undefined }),
      chatgpt("chatgpt", "ChatGPT plan", { authenticated: false }),
      claudeApi(),
    ] });
    expect(ids()).toEqual([]);
    expect(empty()?.textContent).toBe("No accounts yet. Add Claude or ChatGPT to use the plan you already have.");
    expect(document.body.querySelector("[data-accounts-panel] [aria-label^='Remove']")).toBeNull();
    expect(button("Add account")).toBeDefined();
    expect(toggle()).toBeNull();
  });

  it("shows one row per real account with its name, email and plan, an X on each, and the carry-on switch off", () => {
    expect(ids()).toEqual(["claude", "claude-work", "chatgpt"]);
    expect(all("[data-account] button[aria-label^='Rename']").map((element) => element.textContent)).toEqual(["Personal", "Work", "ChatGPT"]);
    expect(line("claude")).toBe("me@example.test · Max");
    expect(line("claude-work")).toBe("Not signed in");
    expect(line("chatgpt")).toBe("me@openai.test · Plus");
    expect(rowButtons("claude")).toEqual([]);
    expect(rowButtons("claude-work")).toEqual(["Sign in"]);
    expect(rowButtons("chatgpt")).toEqual([]);
    expect(["Personal", "Work", "ChatGPT"].map((name) => removeButton(name)?.closest("[data-account]")?.getAttribute("data-account")))
      .toEqual(["claude", "claude-work", "chatgpt"]);
    expect(all("[data-account-usage]")).toEqual([]);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(button("Add account")).toBeDefined();
    expect(document.body.textContent).not.toContain("Claude API");
    expect(document.body.innerHTML.match(/rounded-xl bg-card/g)).toHaveLength(1);
    expect(button("Refresh")).toBeUndefined();
    expect(document.body.querySelector('[data-accounts-refresh][aria-label="Refresh"]')).not.toBeNull();
  });

  it("lists Claude and a second Claude side by side, each removable", async () => {
    await remount({ instances: [
      claude("claude", "Personal", { account: { email: "me@example.test" } }),
      claude("claude-work", "Work", { account: { email: "work@example.test" } }),
      codexLogin({ authenticated: false }),
      chatgpt("chatgpt", "ChatGPT plan", { authenticated: false }),
    ] });
    expect(ids()).toEqual(["claude", "claude-work"]);
    expect(line("claude")).toBe("me@example.test · Max");
    expect(line("claude-work")).toBe("work@example.test");
    expect(removeButton("Personal")).not.toBeNull();
    expect(removeButton("Work")).not.toBeNull();
  });

  it("says signed in when a signed-in account has neither an email nor a plan to show", async () => {
    fixture.report = { providers: [] };
    await act(async () => publish({ instances: [claude("claude", "Personal")] }));
    expect(line("claude")).toBe("Signed in");
  });

  it("shows usage only when the report has real numbers, and nothing while it loads or when it could not be checked", async () => {
    fixture.report = null;
    fixture.loading = true;
    await remount({ instances: [
      claude("claude", "Personal", { account: { email: "me@example.test" } }),
      chatgpt("chatgpt", "ChatGPT", { account: { email: "me@openai.test" } }),
      claude("claude-work", "Work"),
    ] });
    expect(all("[data-account-usage]")).toEqual([]);
    expect(panelText()).not.toContain("Checking usage");

    fixture.loading = false;
    fixture.report = { providers: [unchecked("claude"), usage("chatgpt", null, "Plus"), usage("claude-work", 12)] };
    await act(async () => publish({}));
    expect(usageOf("claude")).toBeNull();
    expect(usageOf("chatgpt")).toBeNull();
    expect(usageOf("claude-work")?.textContent).toBe("88% left");
    expect(usageOf("claude-work")?.getAttribute("title")).toContain("5-hour · 88% left · resets in 2h");
    expect(box("claude-work").querySelector('[role="meter"]')!.getAttribute("aria-valuenow")).toBe("88");
    expect(box("claude").querySelector('[role="meter"]')).toBeNull();
    expect(line("claude")).toBe("me@example.test");
    expect(line("chatgpt")).toBe("me@openai.test · Plus");
    for (const noise of ["Couldn't check usage", "No usage reported yet", "Checking usage"]) expect(panelText()).not.toContain(noise);
  });

  it("keeps each row the same height while its email, plan and usage arrive", async () => {
    fixture.report = null;
    await remount({ instances: [claude("claude", "Personal"), chatgpt("chatgpt", "ChatGPT")] });
    const shape = (instanceId: string) => ({
      box: box(instanceId).className,
      lines: [...box(instanceId).querySelector("[data-account-text]")!.children].map((child) => `${child.tagName}.${child.className}`),
    });
    const before = shape("claude");
    expect(before.box).toContain("min-h-16");
    expect(before.lines).toHaveLength(4);
    expect(before.lines[1]).toContain("h-4");
    expect(before.lines[2]).toContain("h-3");
    expect(before.lines[3]).toContain("h-4");
    expect(box("claude").querySelector('[role="meter"]')).toBeNull();
    expect(line("claude")).toBe("Signed in");

    fixture.report = { providers: [usage("claude", 40)] };
    await act(async () => publish({ instances: signedInAs("claude", "me@example.test") }));
    expect(line("claude")).toBe("me@example.test · Max");
    expect(usageOf("claude")?.textContent).toBe("60% left");
    expect(box("claude").querySelector('[role="meter"]')!.getAttribute("aria-valuenow")).toBe("60");
    expect(usageOf("claude")?.parentElement).toBe(box("claude"));
    expect(shape("claude")).toEqual(before);
    expect(box("chatgpt").className).toBe(before.box);
  });

  it("holds the list's place with a row of the same height until the accounts arrive", async () => {
    await remount({ instances: [] });
    const skeleton = document.body.querySelector<HTMLElement>("[data-account-skeleton]");
    expect(skeleton).not.toBeNull();
    expect(skeleton!.getAttribute("aria-hidden")).toBe("true");
    const fixed = skeleton!.className;
    expect(fixed).toContain("min-h-16");
    expect(ids()).toEqual([]);
    expect(empty()).toBeNull();

    await act(async () => publish({ instances: [claude("claude", "Personal"), chatgpt("chatgpt", "ChatGPT plan", { authenticated: false })] }));
    expect(document.body.querySelector("[data-account-skeleton]")).toBeNull();
    expect(ids()).toEqual(["claude"]);
    expect(box("claude").className).toBe(fixed);

    await remount({ instances: [] });
    await act(async () => publish({ instances: [claude("claude", "Claude", { authenticated: false })] }));
    expect(empty()!.className).toBe(fixed);
  });

  it("puts a resting account to sleep with a line that recharges until it is back", async () => {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await act(async () => publish({ config: { accountBattery: { ...fixture.state.config.accountBattery!, resting: { claude: { since, until, kind: "weekly" } } } } }));
    expect(usageOf("claude")?.textContent).toMatch(/^Back at /);
    expect(usageOf("claude")?.getAttribute("title")).toMatch(/^Back at .+ · in (59m|1h)$/);
    expect(box("claude").firstElementChild?.querySelector("[data-sleeping-dog]")).not.toBeNull();
    expect(usageOf("claude")?.querySelector("[data-sleeping-dog]")).toBeNull();
    expect(box("claude").querySelector("[data-recharge]")!.getAttribute("data-recharge")).toBe("50");
    expect(box("claude").querySelector('[role="meter"]')).toBeNull();
    expect(usageOf("chatgpt")).toBeNull();
  });

  it("renames an account inline once and takes the server's list", async () => {
    await click(row("claude-work")!.querySelector<HTMLButtonElement>('[aria-label="Rename Work"]'));
    const input = row("claude-work")!.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!;
    expect(input.value).toBe("Work");
    expect(box("claude-work").className).toContain("min-h-16");
    await type(input, "Office");
    fixture.api.mockResolvedValueOnce({ instances: fixture.state.instances.map((item) => item.instanceId === "claude-work" ? { ...item, displayName: "Office" } : item) });
    await press(input, "Enter");
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/claude-work", { method: "PATCH", body: JSON.stringify({ displayName: "Office" }) });
    expect(row("claude-work")!.querySelector('[aria-label="Rename Office"]')?.textContent).toBe("Office");
    expect(removeButton("Office")).not.toBeNull();
    expect(row("claude-work")!.querySelector('[role="alert"]')).toBeNull();
  });

  it("leaves the name alone when Escape cancels the edit", async () => {
    await click(row("claude")!.querySelector<HTMLButtonElement>('[aria-label="Rename Personal"]'));
    const input = row("claude")!.querySelector<HTMLInputElement>("input")!;
    await type(input, "Something else");
    await press(input, "Escape");
    expect(fixture.api).not.toHaveBeenCalled();
    expect(row("claude")!.querySelector("input")).toBeNull();
    expect(row("claude")!.querySelector('[aria-label="Rename Personal"]')).not.toBeNull();
  });

  it("saves the carry-on switch with the shown order and takes the server's config", async () => {
    fixture.api.mockResolvedValueOnce({ accountBattery: { enabled: true, order: { claudeAgent: ["claude", "claude-work"], codex: ["chatgpt"] }, resting: {} } });
    await click(toggle());
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ accountBattery: { enabled: true, auto: false, order: { claudeAgent: ["claude", "claude-work"], codex: ["chatgpt"] }, sequence: ["claude", "claude-work", "chatgpt"] } }) });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("says so when the switch could not be saved", async () => {
    fixture.api.mockRejectedValueOnce(new Error("Could not reach this server."));
    await click(toggle());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(document.body.querySelector('[data-accounts-panel] [role="alert"]')?.textContent).toBe("Could not reach this server.");
  });

  it("asks before signing a built-in account out, then removes it, when another account remains", async () => {
    fixture.api.mockResolvedValueOnce({ instances: signedOut("chatgpt") });
    await click(removeButton("ChatGPT"));
    expect(fixture.api).not.toHaveBeenCalled();
    expect(row("chatgpt")!.textContent).toContain("This signs ChatGPT out on this Mac.");
    await click(button("Remove", row("chatgpt")!));
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/chatgpt/auth/sign-out", { method: "POST" });
    expect(ids()).toEqual(["claude", "claude-work"]);
    expect(panelText()).not.toContain("ChatGPT");
  });

  it("signs an added account out before deleting it, so removing it leaves no sign-in behind", async () => {
    await act(async () => publish({ instances: [...fixture.state.instances, claude("claude-side", "Side", { account: { email: "side@example.test" } })] }));
    fixture.api
      .mockResolvedValueOnce({ instances: signedOut("claude-side") })
      .mockResolvedValueOnce({ instances: fixture.state.instances.filter((item) => item.instanceId !== "claude-side") });
    await click(removeButton("Side"));
    await click(button("Remove", row("claude-side")!));
    expect(fixture.api.mock.calls).toEqual([
      ["/api/instances/claude-side/auth/sign-out", { method: "POST" }],
      ["/api/instances/claude-side", { method: "DELETE" }],
    ]);
    expect(ids()).toEqual(["claude", "claude-work", "chatgpt"]);
  });

  it("deletes an added account that never signed in without trying to sign it out", async () => {
    fixture.api.mockResolvedValueOnce({ instances: fixture.state.instances.filter((item) => item.instanceId !== "claude-work") });
    await click(removeButton("Work"));
    expect(fixture.api.mock.calls).toEqual([["/api/instances/claude-work", { method: "DELETE" }]]);
    expect(ids()).toEqual(["claude", "chatgpt"]);
  });

  it("asks inline, in the same row, before signing someone out of their only account", async () => {
    await remount({ instances: [
      claude("claude", "Personal", { account: { email: "me@example.test" } }),
      claude("claude-work", "Work", { authenticated: false }),
      codexLogin({ authenticated: false }),
    ] });
    const fixed = box("claude").className;
    await click(removeButton("Personal"));
    expect(fixture.api).not.toHaveBeenCalled();
    expect(box("claude").className).toBe(fixed);
    expect(line("claude")).toBe("Remove Personal?");
    expect(row("claude")!.textContent).toContain("It's your only account.");
    expect(rowButtons("claude")).toEqual(["Cancel", "Remove"]);
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();

    await click(button("Cancel", row("claude")!));
    expect(line("claude")).toBe("me@example.test · Max");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Remove Personal");

    await click(removeButton("Personal"));
    await press(button("Cancel", row("claude")!)!, "Escape");
    expect(line("claude")).toBe("me@example.test · Max");
    expect(fixture.api).not.toHaveBeenCalled();

    await click(removeButton("Personal"));
    fixture.api.mockResolvedValueOnce({ instances: signedOut("claude") });
    await click(button("Remove", row("claude")!));
    expect(fixture.api.mock.calls).toEqual([["/api/instances/claude/auth/sign-out", { method: "POST" }]]);
    expect(ids()).toEqual(["claude-work"]);

    fixture.api.mockResolvedValueOnce({ instances: fixture.state.instances.filter((item) => item.instanceId !== "claude-work") });
    await click(removeButton("Work"));
    expect(ids()).toEqual([]);
    expect(empty()).not.toBeNull();
  });

  it("keeps the row and says why when the server will not remove it", async () => {
    fixture.api.mockRejectedValueOnce(new Error("Choose another account for the bots and default model using this account before removing it."));
    await click(removeButton("Work"));
    expect(ids()).toEqual(["claude", "claude-work", "chatgpt"]);
    expect(row("claude-work")!.querySelector('[role="alert"]')?.textContent).toBe("Choose another account for the bots and default model using this account before removing it.");
    expect(box("claude-work").className).toContain("min-h-16");
    expect(removeButton("Work")!.disabled).toBe(false);
  });

  it("shows an added account as signed out, with the reason, when it signed out but could not be deleted", async () => {
    await act(async () => publish({ instances: [...fixture.state.instances, claude("claude-side", "Side", { account: { email: "side@example.test" } })] }));
    fixture.api
      .mockResolvedValueOnce({ instances: signedOut("claude-side") })
      .mockRejectedValueOnce(new Error("Choose another account for the bots and default model using this account before removing it."));
    await click(removeButton("Side"));
    await click(button("Remove", row("claude-side")!));
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(ids()).toContain("claude-side");
    expect(line("claude-side")).toBe("Not signed in");
    expect(rowButtons("claude-side")).toEqual(["Sign in"]);
    expect(row("claude-side")!.querySelector('[role="alert"]')?.textContent).toContain("Choose another account");
  });

  it("keeps a row in place when its sign-in drops while the panel is open, until it is removed", async () => {
    await act(async () => publish({ instances: signedOut("claude") }));
    expect(ids()).toEqual(["claude", "claude-work", "chatgpt"]);
    expect(line("claude")).toBe("Not signed in");
    expect(rowButtons("claude")).toEqual(["Sign in"]);
    await click(removeButton("Personal"));
    expect(fixture.api).not.toHaveBeenCalled();
    expect(ids()).toEqual(["claude-work", "chatgpt"]);
    await act(async () => publish({ instances: signedInAs("claude", "me@example.test") }));
    expect(ids()).toEqual(["claude", "claude-work", "chatgpt"]);
  });

  it("adds a Claude account: pick, name, sign in, and the row is signed in with its email when the sheet closes", async () => {
    expect(sheet()).toBeNull();
    await click(button("Add account"));
    expect(sheet()?.getAttribute("aria-label")).toBe("Add account");
    await click(button("Claude", sheet()!));
    expect(sheet()?.getAttribute("aria-label")).toBe("Name this Claude account");
    const input = sheet()!.querySelector<HTMLInputElement>('input[placeholder="Work"]')!;
    expect(button("Continue", sheet()!)!.disabled).toBe(true);
    await type(input, "Side project");
    fixture.api.mockResolvedValueOnce({ instanceId: "claude-side", instances: [...fixture.state.instances, claude("claude-side", "Side project", { authenticated: false })] });
    await click(button("Continue", sheet()!));
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/claude-accounts", { method: "POST", body: JSON.stringify({ displayName: "Side project" }) });
    expect(sheet()?.getAttribute("aria-label")).toBe("Sign in to Side project");
    expect(sheet()!.querySelector('[data-sign-in="claude"]')).not.toBeNull();
    expect(lastSignIn().props).toMatchObject({ instanceId: "claude-side", autoStart: true, compact: true });

    await act(async () => publish({ instances: signedInAs("claude-side", "side@example.test") }));
    await act(async () => lastSignIn().props.onSignedIn!());
    await settle();
    expect(sheet()).toBeNull();
    expect(row("claude-side")!.querySelector('[aria-label="Rename Side project"]')?.textContent).toBe("Side project");
    expect(line("claude-side")).toBe("side@example.test");
    expect(rowButtons("claude-side")).toEqual([]);
    expect(removeButton("Side project")).not.toBeNull();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-accounts-refresh][aria-label="Refresh"]')).not.toBeNull();
  });

  it("signs in to the built-in Claude or ChatGPT account when it has no sign-in yet, instead of naming a new one", async () => {
    await remount({ instances: [
      claude("claude", "Claude", { authenticated: false }),
      codexLogin({ authenticated: false }),
      chatgpt("chatgpt", "ChatGPT plan", { authenticated: false }),
    ] });
    await click(button("Add account"));
    await click(button("Claude", sheet()!));
    expect(sheet()?.getAttribute("aria-label")).toBe("Sign in to Claude");
    expect(lastSignIn()).toMatchObject({ kind: "claude", props: { instanceId: "claude", autoStart: true, compact: true } });
    await act(async () => publish({ instances: signedInAs("claude", "me@example.test") }));
    await act(async () => lastSignIn().props.onSignedIn!());
    await settle();
    expect(sheet()).toBeNull();
    expect(ids()).toEqual(["claude"]);
    expect(line("claude")).toBe("me@example.test · Max");

    await click(button("Add account"));
    await click(button("ChatGPT", sheet()!));
    expect(sheet()?.getAttribute("aria-label")).toBe("Sign in to ChatGPT plan");
    expect(lastSignIn()).toMatchObject({ kind: "device", props: { instanceId: "chatgpt", browserPkce: true, autoStart: true } });
    await act(async () => lastSignIn().props.onCancelled!());
    expect(sheet()).toBeNull();
    expect(ids()).toEqual(["claude"]);
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("fetches the list again when the sign-in's snapshot lags, and still ends signed in without a refresh press", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await click(button("Sign in", row("claude-work")!));
    expect(sheet()?.getAttribute("aria-label")).toBe("Sign in to Work");
    expect(lastSignIn().props.instanceId).toBe("claude-work");
    fixture.api.mockImplementation(async (path: string) => {
      if (path !== "/api/instances") throw new Error(`unexpected ${path}`);
      return { instances: signedInAs("claude-work", "work@example.test") };
    });
    await act(async () => lastSignIn().props.onSignedIn!());
    await settle();
    expect(sheet()).not.toBeNull();
    expect(fixture.api).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    await settle();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
    expect(line("claude-work")).toBe("work@example.test");
    expect(rowButtons("claude-work")).toEqual([]);
  });

  it("adds a ChatGPT account through the browser sign-in and ends with the row signed in", async () => {
    await click(button("Add account"));
    await click(button("ChatGPT", sheet()!));
    expect(sheet()?.getAttribute("aria-label")).toBe("Name this ChatGPT account");
    await type(sheet()!.querySelector<HTMLInputElement>("input")!, "Team");
    fixture.api.mockResolvedValueOnce({ instanceId: "chatgpt-team", instances: [...fixture.state.instances, chatgpt("chatgpt-team", "Team", { authenticated: false })] });
    await click(button("Continue", sheet()!));
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/chatgpt-accounts", { method: "POST", body: JSON.stringify({ displayName: "Team" }) });
    expect(sheet()!.querySelector('[data-sign-in="device"]')).not.toBeNull();
    expect(lastSignIn().props).toMatchObject({ instanceId: "chatgpt-team", browserPkce: true, autoStart: true, compact: true });
    await act(async () => publish({ instances: signedInAs("chatgpt-team", "team@openai.test") }));
    await act(async () => lastSignIn().props.onSignedIn!());
    await settle();
    expect(sheet()).toBeNull();
    expect(line("chatgpt-team")).toBe("team@openai.test · ChatGPT");
    expect(rowButtons("chatgpt-team")).toEqual([]);
  });

  it("keeps the half-added account listed when the sign-in is cancelled, ready to sign in later", async () => {
    await click(button("Add account"));
    await click(button("Claude", sheet()!));
    await type(sheet()!.querySelector<HTMLInputElement>("input")!, "Later");
    fixture.api.mockResolvedValueOnce({ instanceId: "claude-later", instances: [...fixture.state.instances, claude("claude-later", "Later", { authenticated: false })] });
    await click(button("Continue", sheet()!));
    await act(async () => lastSignIn().props.onCancelled!());
    expect(sheet()).toBeNull();
    expect(line("claude-later")).toBe("Not signed in");
    expect(rowButtons("claude-later")).toEqual(["Sign in"]);
    expect(removeButton("Later")).not.toBeNull();
  });

  it("shows the server's refusal to add an account and stays on the name step", async () => {
    await click(button("Add account"));
    await click(button("Claude", sheet()!));
    await type(sheet()!.querySelector<HTMLInputElement>("input")!, "Work");
    fixture.api.mockRejectedValueOnce(new Error("An account with that name already exists."));
    await click(button("Continue", sheet()!));
    expect(sheet()?.getAttribute("aria-label")).toBe("Name this Claude account");
    expect(sheet()!.querySelector('[role="alert"]')?.textContent).toBe("An account with that name already exists.");
    await click(button("Back", sheet()!));
    expect(sheet()?.getAttribute("aria-label")).toBe("Add account");
  });

  it("says the account is gone when it disappears while signing in", async () => {
    await click(button("Sign in", row("claude-work")!));
    await act(async () => publish({ instances: fixture.state.instances.filter((item) => item.instanceId !== "claude-work") }));
    expect(sheet()!.querySelector('[role="alert"]')?.textContent).toBe("This account is no longer here.");
  });

  it("opens the Add sheet when another screen asks for another account", async () => {
    await act(async () => requestAddAccount());
    expect(sheet()?.getAttribute("aria-label")).toBe("Add account");
    await click(button("Cancel", sheet()!));
    expect(sheet()).toBeNull();
  });
});

describe("adding a provider with an API key", () => {
  const keyed = (instanceId: string, driverKind: string, displayName: string, patch: Partial<InstanceInfo> = {}): InstanceInfo => ({
    instanceId, driverKind, displayName, access: "api",
    snapshot: { state: "available", authenticated: false },
    models: { default: "", options: [] },
    ...patch,
  } as InstanceInfo);
  const providers = () => [
    keyed("cerebras", "cerebras", "Cerebras"),
    { ...keyed("company-router", "openai-compat", "Company router"), managed: { organizationId: "org", organizationName: "Org" } },
    keyed("openaiCompat", "openai-compat", "Other (OpenAI-compatible)"),
    keyed("xai", "grok", "xAI", { snapshot: { state: "available", authenticated: true } }),
    keyed("openai", "openai-compat", "OpenAI"),
    { ...claudeApi(), snapshot: { ...claudeApi().snapshot, authenticated: false, version: "2.1.0" } },
    keyed("mistral", "mistral", "Mistral"),
    keyed("openrouter", "openai-compat", "OpenRouter"),
  ];
  const more = () => sheet()!.querySelector<HTMLButtonElement>("[data-more-providers-toggle]");
  const listed = () => all("[data-key-provider]").map((element) => element.dataset.keyProvider);
  const pick = (instanceId: string) => sheet()!.querySelector<HTMLButtonElement>(`[data-key-provider="${instanceId}"]`);

  beforeEach(async () => {
    await remount({ instances: [...fixture.state.instances.filter((item) => item.instanceId !== "claudeApi"), ...providers()] });
    await click(button("Add account"));
  });

  it("keeps the other providers folded under a quiet toggle, in a steady order, without anything a company manages", async () => {
    expect(sheet()!.parentElement).toBe(document.body);
    expect(button("Claude", sheet()!)).toBeTruthy();
    expect(button("ChatGPT", sheet()!)).toBeTruthy();
    expect(more()?.textContent).toBe("More providers");
    expect(more()?.getAttribute("aria-expanded")).toBe("false");
    expect(listed()).toEqual([]);
    await click(more());
    expect(more()?.getAttribute("aria-expanded")).toBe("true");
    expect(listed()).toEqual(["openrouter", "xai", "openai", "claudeApi", "mistral", "cerebras", "openaiCompat"]);
    expect(pick("xai")!.textContent).toContain("Connected");
    expect(pick("openrouter")!.textContent).toContain("OpenRouter");
    expect(pick("openrouter")!.textContent).not.toContain("Connected");
    await click(more());
    expect(listed()).toEqual([]);
  });

  it("saves and checks an OpenRouter key right in the sheet, then Done closes it", async () => {
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/config") return { ...fixture.state.config, openrouter: { configured: true } };
      if (path === "/api/keys/test") return { ok: true, check: "authentication" };
      throw new Error(`unexpected ${path}`);
    });
    await click(more());
    await click(pick("openrouter"));
    expect(sheet()?.getAttribute("aria-label")).toBe("Add OpenRouter");
    expect(sheet()!.querySelector<HTMLAnchorElement>('a[href="https://openrouter.ai/keys"]')?.target).toBe("_blank");
    const input = sheet()!.querySelector<HTMLInputElement>('input[aria-label="OpenRouter API key"]')!;
    expect(input.type).toBe("password");
    expect(document.activeElement).toBe(input);
    await type(input, "sk-or-v1-fixture");
    await press(input, "Enter");
    expect(fixture.api.mock.calls).toEqual([
      ["/api/config", { method: "PUT", body: JSON.stringify({ openrouter: { key: "sk-or-v1-fixture" } }) }],
      ["/api/keys/test", { method: "POST", body: JSON.stringify({ provider: "openrouter" }) }],
    ]);
    expect(sheet()!.querySelector('[role="status"]')?.textContent).toBe("Saved key: API key authenticated. Chat not tested.");
    expect(sheet()).not.toBeNull();
    await click(button("Done", sheet()!));
    expect(sheet()).toBeNull();
  });

  it("goes Back to the open list with focus kept in the sheet, and Escape closes it", async () => {
    await click(more());
    await click(pick("xai"));
    expect(sheet()?.getAttribute("aria-label")).toBe("Add xAI");
    await click(button("Back", sheet()!));
    expect(sheet()?.getAttribute("aria-label")).toBe("Add account");
    expect(more()?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(sheet());
    await press(sheet()!, "Escape");
    expect(sheet()).toBeNull();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("asks a custom OpenAI-compatible server for its address before its key", async () => {
    await click(more());
    await click(pick("openaiCompat"));
    expect(sheet()?.getAttribute("aria-label")).toBe("Add an OpenAI-compatible server");
    const inputs = [...sheet()!.querySelectorAll("input")];
    expect(inputs.map((input) => input.getAttribute("aria-label"))).toEqual(["OpenAI-compatible base URL", "OpenAI-compatible API key"]);
    expect(document.activeElement).toBe(inputs[0]);
  });

  it("offers no providers to a window driving another computer", async () => {
    await click(button("Cancel", sheet()!));
    const previous = window.laterdog;
    window.laterdog = { remoteClient: { active: true } } as unknown as typeof window.laterdog;
    try {
      await click(button("Add account"));
      expect(more()).toBeNull();
      expect(button("Cancel", sheet()!)).toBeTruthy();
    } finally {
      window.laterdog = previous;
    }
  });
});

describe("reordering accounts", () => {
  let carryOn: ReturnType<typeof useCarryOn>;
  function Probe() {
    carryOn = useCarryOn();
    return null;
  }
  const reordered = { claudeAgent: ["claude-new", "claude-work", "claude"], codex: ["chatgpt"] };

  beforeEach(async () => {
    await act(async () => publish({ instances: [...fixture.state.instances, claude("claude-new", "New")] }));
    await act(async () => root.render(createElement(Probe)));
  });

  it("shows the new order at once, keeps a hidden account in its place, and takes the server's config", async () => {
    let answer!: (config: unknown) => void;
    fixture.api.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    await act(async () => { void carryOn.reorder(["claude-new", "claude", "chatgpt"]); });
    expect(fixture.state.config.accountBattery!.order).toEqual(reordered);
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ accountBattery: { enabled: false, auto: false, order: reordered, sequence: ["claude-new", "claude", "chatgpt", "claude-work"] } }) });
    expect(carryOn.saving).toBe(true);
    const saved = { accountBattery: { enabled: false, order: reordered, resting: {} } };
    await act(async () => answer(saved));
    await settle();
    expect(fixture.state.config).toEqual(saved);
    expect(carryOn.saving).toBe(false);
  });

  it("puts the old order back and says why when it could not be saved", async () => {
    const before = fixture.state.config;
    fixture.api.mockRejectedValueOnce(new Error("Could not reach this server."));
    await act(async () => { await carryOn.reorder(["claude-new", "claude", "chatgpt"]); });
    await settle();
    expect(fixture.state.config).toEqual(before);
    expect(carryOn.error).toBe("Could not reach this server.");
  });

  it("locks ordering only while automatic management is enabled", async () => {
    await act(async () => publish({ config: { accountBattery: { ...fixture.state.config.accountBattery!, enabled: true, auto: true } } }));
    expect(carryOn.canReorder).toBe(false);
    await act(async () => carryOn.reorder(["chatgpt", "claude"]));
    expect(fixture.api).not.toHaveBeenCalled();
    await act(async () => publish({ config: { accountBattery: { ...fixture.state.config.accountBattery!, enabled: false } } }));
    expect(carryOn.canReorder).toBe(true);
  });

  it("can reorder only once the server has said how accounts carry on", async () => {
    expect(carryOn.canReorder).toBe(true);
    await act(async () => publish({ config: {} }));
    expect(carryOn.canReorder).toBe(false);
    await act(async () => { await carryOn.reorder(["claude-new", "claude", "chatgpt"]); });
    expect(fixture.api).not.toHaveBeenCalled();
  });
});

describe("moving an account in Settings", () => {
  const grip = (instanceId: string) => row(instanceId)?.querySelector<HTMLButtonElement>("[data-account-grip]") ?? null;
  const saved = (claudeAgent: string[]) => ["/api/config", { method: "PUT", body: JSON.stringify({ accountBattery: { enabled: false, auto: false, order: { claudeAgent, codex: ["chatgpt"] }, sequence: [...claudeAgent, "chatgpt"] } }) }];
  const answer = (claudeAgent: string[]) => ({ accountBattery: { enabled: false, order: { claudeAgent, codex: ["chatgpt"] }, resting: {} } });
  const drag = async (element: Element, kind: "dragstart" | "dragover" | "drop" | "dragend", transfer: DataTransfer) => {
    const event = new Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    await act(async () => { element.dispatchEvent(event); });
  };

  it("moves an account with its handle and preserves keyboard focus", async () => {
    fixture.api.mockResolvedValueOnce(answer(["claude-work", "claude"]));
    const handle = grip("claude")!;
    expect(handle.getAttribute("aria-label")).toBe("Move Personal");
    expect(handle.getAttribute("title")).toBe("Drag to reorder");
    expect(grip("chatgpt")).not.toBeNull();
    handle.focus();
    await press(handle, "ArrowUp");
    expect(fixture.api).not.toHaveBeenCalled();
    await press(handle, "ArrowDown");
    expect(fixture.api).toHaveBeenCalledWith(...saved(["claude-work", "claude"]));
    expect(ids()).toEqual(["claude-work", "claude", "chatgpt"]);
    expect(document.activeElement).toBe(handle);
    await press(grip("chatgpt")!, "ArrowDown");
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(["claude-work", "claude", "chatgpt"]);
  });

  it("drags an account onto another of its engine, shows the order at once, and saves it on the drop", async () => {
    fixture.api.mockResolvedValueOnce(answer(["claude-work", "claude"]));
    expect(row("claude")!.getAttribute("draggable")).toBe("true");
    expect(row("chatgpt")!.getAttribute("draggable")).toBe("true");
    const transfer = new DataTransfer();
    await drag(row("claude-work")!, "dragstart", transfer);
    await drag(row("chatgpt")!, "dragover", transfer);
    expect(ids()).toEqual(["claude", "chatgpt", "claude-work"]);
    await drag(row("claude")!, "dragover", transfer);
    expect(ids()).toEqual(["claude-work", "claude", "chatgpt"]);
    expect(fixture.api).not.toHaveBeenCalled();
    await drag(row("claude")!, "drop", transfer);
    await drag(row("claude-work")!, "dragend", transfer);
    await settle();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledWith(...saved(["claude-work", "claude"]));
    expect(ids()).toEqual(["claude-work", "claude", "chatgpt"]);
  });

  it("holds a row still while its name is being edited, so dragging text in the field moves nothing", async () => {
    await click(row("claude")!.querySelector<HTMLButtonElement>('[aria-label="Rename Personal"]'));
    const input = row("claude")!.querySelector("input")!;
    expect(row("claude")!.getAttribute("draggable")).toBeNull();
    const transfer = new DataTransfer();
    await drag(input, "dragstart", transfer);
    await drag(row("claude-work")!, "dragover", transfer);
    expect(transfer.getData("application/x-laterdog-account")).toBe("");
    expect(ids()).toEqual(["claude", "claude-work", "chatgpt"]);
  });

  it("offers no handle or drag until the server has said how accounts carry on", async () => {
    await act(async () => publish({ config: {} }));
    expect(document.body.querySelector("[data-account-grip]")).toBeNull();
    expect(document.body.querySelector("[data-account][draggable]")).toBeNull();
  });
});
