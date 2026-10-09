// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, ConfigStatus, InstanceInfo } from "@/state/store";
import { setLocale } from "@/lib/i18n";
import { failedTurnTool, type FailedTurnQuota } from "../../shared/failed-turn";

type Battery = NonNullable<ConfigStatus["accountBattery"]>;
type State = Pick<AppState, "bots" | "instances" | "pendingQueued"> & { config: { accountBattery?: Battery } };

const fixture = vi.hoisted(() => ({
  state: {} as unknown as State,
  listeners: new Set<() => void>(),
  api: vi.fn(),
  dispatched: [] as Array<{ type: string; open?: boolean; section?: string }>,
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
  const dispatch = (action: { type: string; config?: ConfigStatus }) => {
    fixture.dispatched.push(action);
    if (action.type === "configStatus") publish({ config: action.config! });
  };
  return {
    api: fixture.api,
    useStore: () => ({ state: useSyncExternalStore(subscribe, () => fixture.state), dispatch }),
  };
});

const { LimitRow } = await import("./LimitRow");
const { subscribeAddAccount } = await import("@/lib/add-account-request");

const NOW = Date.parse("2026-10-09T13:00:00");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const MODEL = "claude-opus-5";

const claude = (instanceId: string, displayName: string, snapshot: Partial<InstanceInfo["snapshot"]> = {}, models = [MODEL]): InstanceInfo => ({
  instanceId, driverKind: "claudeAgent", displayName, access: "subscription",
  snapshot: { state: "available", authenticated: true, ...snapshot },
  models: { default: MODEL, options: models.map((id) => ({ id, label: id })) },
});
const chatgpt = (instanceId: string, displayName: string): InstanceInfo => ({
  instanceId, driverKind: "codex", displayName, access: "subscription",
  snapshot: { state: "available", authenticated: true, chatgptPlan: true },
  models: { default: "gpt-5", options: [{ id: "gpt-5", label: "gpt-5" }] },
});
const dog = { id: "scout", name: "Scout", threadId: "thread-scout", modelSelection: { instanceId: "claude", model: MODEL } } as Bot;
const battery = (resting: Battery["resting"] = {}, enabled = false): Battery => ({
  enabled, order: { claudeAgent: ["claude", "claude-work", "claude-side"], codex: ["chatgpt"] }, resting,
});
const limit = (quota: FailedTurnQuota) => failedTurnTool("You've hit your limit · resets 3pm", { quota: { instanceId: "claude", ...quota } });

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
const card = () => document.body.querySelector<HTMLElement>("[data-limit-row]");
const words = () => card()?.textContent?.replace(/\s+/g, " ") ?? "";
const headline = () => card()?.querySelector("p")?.textContent;
const pills = () => [...card()!.querySelectorAll<HTMLButtonElement>('button:not([role="switch"])')];
const buttons = () => pills().map((element) => element.textContent?.trim());
const button = (label: string) => pills().find((element) => element.textContent?.trim() === label);
const toggle = () => card()!.querySelector<HTMLButtonElement>('[role="switch"]');
const click = async (element: HTMLElement | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => element!.click());
  await settle();
};
const render = async (tool: ReturnType<typeof limit>, props: { onRetry?: () => void; botId?: string; threadId?: string } = { onRetry: vi.fn(), botId: "scout", threadId: "thread-scout" }) => {
  await act(async () => root.render(createElement(LimitRow, { tool, ...props })));
  return props;
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  setLocale("en");
  fixture.listeners.clear();
  fixture.dispatched = [];
  fixture.api.mockReset();
  fixture.state = {
    bots: [dog],
    instances: [claude("claude", "Personal"), claude("claude-work", "Work"), chatgpt("chatgpt", "ChatGPT")],
    pendingQueued: {},
    config: { accountBattery: battery({ claude: { until: inHours(2), kind: "session" } }) },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the limit message", () => {
  it("names the account and the limit it hit, and when it comes back", async () => {
    await render(limit({ kind: "session" }));
    expect(headline()).toBe("Personal hit its 5-hour limit.");
    expect(words()).toContain("Resets 3:00 PM (in 2h)");
  });

  it("words each kind of limit, and any other as out of usage", async () => {
    const cases: Array<[string | undefined, string]> = [
      ["daily", "Personal hit its daily limit."],
      ["weekly", "Personal hit its weekly limit."],
      ["monthly", "Personal hit its monthly limit."],
      ["opus", "Personal hit its Opus limit."],
      ["sonnet", "Personal hit its Sonnet limit."],
      [undefined, "Personal is out of usage for now."],
      ["constructor", "Personal is out of usage for now."],
    ];
    for (const [kind, expected] of cases) {
      await render(limit({ kind }));
      expect(headline()).toBe(expected);
    }
  });

  it("reads the reset from the battery, says when it isn't known, and offers Retry once it has passed", async () => {
    publish({ config: { accountBattery: battery({ claude: { until: inHours(30), kind: "weekly" } }) } });
    await render(limit({ kind: "weekly", resetsAt: inHours(2) }));
    expect(words()).toMatch(/Resets Oct 10,? (at )?7:00 PM \(in 1d 6h\)/);

    publish({ config: { accountBattery: battery({ claude: { until: inHours(1), estimated: true } }) } });
    await settle();
    expect(words()).toContain("Reset time not known yet.");

    const onRetry = vi.fn();
    publish({ config: { accountBattery: battery({ claude: { until: inHours(-1), kind: "session" } }) } });
    await render(limit({ kind: "session" }), { onRetry, botId: "scout", threadId: "thread-scout" });
    expect(words()).toContain("It should be ready again now.");
    expect(buttons()).toEqual(["Retry"]);
    await click(button("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("treats an account the battery no longer rests as ready again", async () => {
    publish({ config: { accountBattery: battery({}) } });
    await render(limit({ kind: "session", resetsAt: inHours(2) }));
    expect(words()).toContain("It should be ready again now.");
    expect(buttons()).toEqual(["Retry"]);
  });

  it("falls back to the row's own reset time without a battery", async () => {
    publish({ config: {} });
    await render(limit({ kind: "session", resetsAt: inHours(2) }));
    expect(words()).toContain("Resets 3:00 PM (in 2h)");
    expect(buttons()).toEqual(["Continue on Work"]);
  });

  it("continues on the one free account in one tap", async () => {
    fixture.api.mockResolvedValueOnce({ continued: true });
    const props = await render(limit({ kind: "session" }));
    expect(buttons()).toEqual(["Continue on Work"]);
    await click(button("Continue on Work"));
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/continue-on", {
      method: "POST", body: JSON.stringify({ threadId: "thread-scout", instanceId: "claude-work" }),
    });
    expect(props.onRetry).not.toHaveBeenCalled();
  });

  it("lets the person pick between free accounts, and only ones that can run this dog", async () => {
    publish({ instances: [
      ...fixture.state.instances,
      claude("claude-side", "Side"),
      claude("claude-small", "Small", {}, ["claude-haiku-5"]),
      claude("claude-out", "Signed out", { authenticated: false }),
    ] });
    fixture.api.mockResolvedValueOnce({ continued: true });
    await render(limit({ kind: "session" }));
    const select = card()!.querySelector("select")!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Work", "Side"]);
    expect(card()!.querySelector(`label[for="${select.id}"]`)?.textContent).toBe("Continue on");
    await act(async () => {
      select.value = "claude-side";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button("Continue"));
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/continue-on", {
      method: "POST", body: JSON.stringify({ threadId: "thread-scout", instanceId: "claude-side" }),
    });
  });

  it("retries the turn itself when the server had nothing to rerun", async () => {
    fixture.api.mockResolvedValueOnce({ continued: false });
    const props = await render(limit({ kind: "session" }));
    await click(button("Continue on Work"));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows why it could not continue, and keeps the button", async () => {
    fixture.api.mockRejectedValueOnce(new Error("Work is out of usage too."));
    await render(limit({ kind: "session" }));
    await click(button("Continue on Work"));
    expect(card()!.querySelector('[role="alert"]')?.textContent).toBe("Work is out of usage too.");
    expect(button("Continue on Work")?.disabled).toBe(false);
  });

  it("asks for another account when there is none, and opens Add account", async () => {
    publish({ instances: [claude("claude", "Personal"), chatgpt("chatgpt", "ChatGPT")] });
    await render(limit({ kind: "session" }));
    expect(words()).toContain("Add another account to keep going.");
    expect(toggle()).toBeNull();
    await click(button("Add account"));
    expect(fixture.dispatched).toContainEqual({ type: "toggleAppSettings", open: true, section: "general" });
    const open = vi.fn();
    subscribeAddAccount(open)();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("says the other accounts can't take over when they are resting or signed out", async () => {
    publish({
      instances: [claude("claude", "Personal"), claude("claude-work", "Work"), claude("claude-side", "Side", { authenticated: false })],
      config: { accountBattery: battery({ claude: { until: inHours(2), kind: "session" }, "claude-work": { until: inHours(4), kind: "session" } }) },
    });
    await render(limit({ kind: "session" }));
    expect(words()).toContain("Your other accounts can't take over right now.");
    expect(button("Add account")).toBeTruthy();
  });

  it("saves the carry-on switch from the message", async () => {
    fixture.api.mockResolvedValueOnce({ accountBattery: battery({ claude: { until: inHours(2), kind: "session" } }, true) });
    await render(limit({ kind: "session" }));
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    await click(toggle());
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PUT", body: JSON.stringify({ accountBattery: { enabled: true, order: { claudeAgent: ["claude", "claude-work"], codex: ["chatgpt"] } } }),
    });
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  });

  it("counts the messages waiting for this conversation", async () => {
    publish({ pendingQueued: { "thread-scout": [{ queueId: "q1", text: "one" }, { queueId: "q2", text: "two" }], other: [{ queueId: "q3", text: "x" }] } });
    await render(limit({ kind: "session" }));
    expect(words()).toContain("2 message(s) waiting. They'll send once this dog can carry on.");
  });

  it("shows only what happened where the conversation can't act on it", async () => {
    await render(limit({ kind: "session" }), {});
    expect(headline()).toBe("Personal hit its 5-hour limit.");
    expect(buttons()).toEqual([]);
    expect(toggle()).toBeNull();
    expect(words()).not.toContain("Resets");
    expect(card()!.querySelector("details")?.textContent).toContain("You've hit your limit · resets 3pm");
  });

  it("calls an account it doesn't know this account", async () => {
    await render(limit({ kind: "weekly", instanceId: "gone" }));
    expect(headline()).toBe("This account hit its weekly limit.");
    expect(buttons()).toEqual(["Retry"]);
  });
});
