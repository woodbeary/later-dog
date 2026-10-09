// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";

type State = { config: Pick<ConfigStatus, "accountBattery">; instances: InstanceInfo[] };
type SignInProps = { instanceId: string; autoStart?: boolean; compact?: boolean; browserPkce?: boolean; onSignedIn?: () => void; onCancelled?: () => void };

const fixture = vi.hoisted(() => ({
  state: { config: {}, instances: [] } as unknown as State,
  listeners: new Set<() => void>(),
  api: vi.fn(),
  signIns: [] as Array<{ kind: "claude" | "device"; props: SignInProps }>,
  report: null as { providers: { id: string; plan?: string | null }[] } | null,
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
    useStore: () => ({ state: useSyncExternalStore(subscribe, () => fixture.state), dispatch }),
  };
});
vi.mock("./PlanUsage", () => ({
  usePlanUsage: () => ({ report: fixture.report, loading: false, now: Date.now() }),
  AccountUsage: ({ provider, resting }: { provider?: { id: string }; resting?: { until: string } }) =>
    createElement("div", { "data-usage": provider?.id ?? "none", "data-resting": resting ? "yes" : "no" }),
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

const { AccountsPanel, accountOrder, pollSignedIn, removable, subscriptionAccounts } = await import("./AccountsPanel");
const { requestAddAccount } = await import("@/lib/add-account-request");

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
const signedInAs = (instanceId: string, email: string) => fixture.state.instances.map((item) =>
  item.instanceId === instanceId ? { ...item, snapshot: { ...item.snapshot, state: "available" as const, authenticated: true, account: { email } } } : item);

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
const all = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
const button = (label: string, within: ParentNode = document.body) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);
const row = (instanceId: string) => document.body.querySelector<HTMLElement>(`[data-account="${instanceId}"]`);
const line = (instanceId: string) => row(instanceId)?.querySelector("p")?.textContent;
const rowButtons = (instanceId: string) => [...row(instanceId)!.querySelectorAll("button:not([aria-label])")].map((element) => element.textContent?.trim());
const sheet = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
const confirmDialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
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
const press = async (input: HTMLInputElement, key: string) => {
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  await settle();
};
const lastSignIn = () => fixture.signIns.at(-1)!;

beforeEach(async () => {
  setLocale("en");
  fixture.listeners.clear();
  fixture.signIns = [];
  fixture.report = { providers: [{ id: "claude", plan: "Max" }, { id: "chatgpt", plan: "Plus" }] };
  fixture.state = {
    instances: [
      claude("claude", "Personal", { account: { email: "me@example.test" } }),
      claude("claude-work", "Work", { authenticated: false }),
      chatgpt("chatgpt", "ChatGPT", { account: { email: "me@openai.test" } }),
      { ...claude("claudeApi", "Claude API", { account: { method: "api-key" } }), access: "api" },
    ],
    config: { accountBattery: { enabled: false, order: { claudeAgent: ["claude", "claude-work"], codex: ["chatgpt"] }, resting: {} } },
  };
  fixture.api.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(AccountsPanel)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
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
  it("shows one row per account with its name, email and plan, and the carry-on switch off", () => {
    expect(all("[data-account]").map((element) => element.dataset.account)).toEqual(["claude", "claude-work", "chatgpt"]);
    expect(all("[data-account] button[aria-label^='Rename']").map((element) => element.textContent)).toEqual(["Personal", "Work", "ChatGPT"]);
    expect(line("claude")).toBe("me@example.test · Max");
    expect(line("claude-work")).toBe("Not signed in");
    expect(line("chatgpt")).toBe("me@openai.test · Plus");
    expect(rowButtons("claude")).toEqual(["Sign out"]);
    expect(rowButtons("claude-work")).toEqual(["Sign in", "Remove"]);
    expect(rowButtons("chatgpt")).toEqual(["Sign out"]);
    expect(row("claude")!.querySelector('[data-usage="claude"]')).not.toBeNull();
    expect(row("claude-work")!.querySelector("[data-usage]")).toBeNull();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(button("Add account")).toBeDefined();
    expect(document.body.textContent).not.toContain("Claude API");
    expect(document.body.innerHTML.match(/rounded-xl bg-card/g)).toHaveLength(1);
    expect(button("Refresh")).toBeUndefined();
    expect(document.body.querySelector('[aria-label="Refresh"]')).toBeNull();
  });

  it("says signed in when a signed-in account has neither an email nor a plan to show", async () => {
    fixture.report = { providers: [] };
    await act(async () => publish({ instances: [claude("claude", "Personal")] }));
    expect(line("claude")).toBe("Signed in");
  });

  it("shows a resting account as resting", async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await act(async () => publish({ config: { accountBattery: { ...fixture.state.config.accountBattery!, resting: { claude: { until, kind: "weekly" } } } } }));
    expect(row("claude")!.querySelector("[data-usage]")!.getAttribute("data-resting")).toBe("yes");
    expect(row("chatgpt")!.querySelector("[data-usage]")!.getAttribute("data-resting")).toBe("no");
  });

  it("renames an account inline once and takes the server's list", async () => {
    await click(row("claude-work")!.querySelector<HTMLButtonElement>('[aria-label="Rename Work"]'));
    const input = row("claude-work")!.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!;
    expect(input.value).toBe("Work");
    await type(input, "Office");
    fixture.api.mockResolvedValueOnce({ instances: fixture.state.instances.map((item) => item.instanceId === "claude-work" ? { ...item, displayName: "Office" } : item) });
    await press(input, "Enter");
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/claude-work", { method: "PATCH", body: JSON.stringify({ displayName: "Office" }) });
    expect(row("claude-work")!.querySelector('[aria-label="Rename Office"]')?.textContent).toBe("Office");
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
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PUT", body: JSON.stringify({ accountBattery: { enabled: true, order: { claudeAgent: ["claude", "claude-work"], codex: ["chatgpt"] } } }) });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("says so when the switch could not be saved", async () => {
    fixture.api.mockRejectedValueOnce(new Error("Could not reach this server."));
    await click(toggle());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(document.body.querySelector('[data-accounts-panel] [role="alert"]')?.textContent).toBe("Could not reach this server.");
  });

  it("signs out and removes through a confirmation, each taking the server's list", async () => {
    await click(button("Sign out", row("claude")!));
    expect(confirmDialog()?.textContent).toContain("Sign out Personal?");
    fixture.api.mockResolvedValueOnce({ instances: fixture.state.instances.map((item) => item.instanceId === "claude" ? { ...item, snapshot: { state: "available" as const, authenticated: false } } : item) });
    await click(button("Sign out", confirmDialog()!));
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/claude/auth/sign-out", { method: "POST" });
    expect(confirmDialog()).toBeNull();
    expect(line("claude")).toBe("Not signed in");
    expect(rowButtons("claude")).toEqual(["Sign in"]);

    await click(button("Remove", row("claude-work")!));
    expect(confirmDialog()?.textContent).toContain("Remove Work?");
    await click(button("Cancel", confirmDialog()!));
    expect(confirmDialog()).toBeNull();
    expect(fixture.api).toHaveBeenCalledTimes(1);

    await click(button("Remove", row("claude-work")!));
    fixture.api.mockResolvedValueOnce({ instances: fixture.state.instances.filter((item) => item.instanceId !== "claude-work") });
    await click(button("Remove", confirmDialog()!));
    expect(fixture.api).toHaveBeenCalledWith("/api/instances/claude-work", { method: "DELETE" });
    expect(all("[data-account]").map((element) => element.dataset.account)).toEqual(["claude", "chatgpt"]);
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
    expect(rowButtons("claude-side")).toEqual(["Sign out", "Remove"]);
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[aria-label="Refresh"]')).toBeNull();
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
    expect(rowButtons("claude-work")).toEqual(["Sign out", "Remove"]);
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
    expect(rowButtons("chatgpt-team")).toEqual(["Sign out", "Remove"]);
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
    expect(rowButtons("claude-later")).toEqual(["Sign in", "Remove"]);
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
