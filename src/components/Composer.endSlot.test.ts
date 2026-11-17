// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("@/lib/mic-recorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mic-recorder")>()),
  micRecordingSupported: () => true,
}));
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), queueing: true }));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", capabilities: { queueing: fixture.queueing } }],
      },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { Composer } = await import("./Composer");
const { appendComposerDraft } = await import("@/lib/drafts");
const { setLocale } = await import("@/lib/i18n");
const { reloadPlanUsage } = await import("./PlanUsage");
const { QUESTION_DISMISS_MESSAGE } = await import("../../shared/ask-question");

const juniper = (busy: boolean, threadId: string): Bot => ({
  id: "juniper", threadId, name: "Juniper", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], busy,
  modelSelection: { instanceId: "claude", model: "claude-fake" },
});

let host: HTMLDivElement;
let root: Root;
let count = 0;

const mount = async (busy: boolean, draft = "", messages: Bot["messages"] = []) => {
  count += 1;
  const bot = { ...juniper(busy, `end-slot-${count}`), messages };
  if (draft) appendComposerDraft(`bot:${bot.id}:${bot.threadId}`, draft);
  await act(async () => root.render(createElement(Composer, { bot })));
  return bot;
};
const actions = () => fixture.dispatch.mock.calls.map(([action]) => action.type as string);
const endSlot = () => [...host.querySelectorAll("[data-composer-actions] > button")].map((button) =>
  button.hasAttribute("data-composer-send") ? "send" : button.hasAttribute("data-composer-stop") ? "stop" : button.hasAttribute("data-composer-mic") ? "mic" : "other");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  setLocale("en");
  fixture.dispatch.mockReset();
  fixture.queueing = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the composer's end slot", () => {
  it("holds only the mic while the field is empty and the dog is idle", async () => {
    await mount(false);
    expect(endSlot()).toEqual(["mic"]);
  });

  it("holds send alone, a round disc with an arrow, once there is a draft", async () => {
    await mount(false, "add a pickup time");
    expect(endSlot()).toEqual(["send"]);
    const send = host.querySelector<HTMLButtonElement>("[data-composer-send]")!;
    expect(send.disabled).toBe(false);
    expect(send.querySelector("svg.lucide-arrow-up")).not.toBeNull();
  });

  it("holds the mic and then stop while the dog works and the field is empty", async () => {
    await mount(true);
    expect(endSlot()).toEqual(["mic", "stop"]);
    expect(host.querySelector("textarea")!.placeholder).toBe("Message Juniper while it works");
  });

  it("swaps stop for send as soon as there is a draft while the dog works", async () => {
    await mount(true, "also the small phone");
    expect(endSlot()).toEqual(["send"]);
  });

  it("shows the same arrow while the dog works on an account that only queues", async () => {
    fixture.queueing = false;
    await mount(true, "also the small phone");
    expect(endSlot()).toEqual(["send"]);
    expect(host.querySelector("[data-composer-send] svg.lucide-arrow-up")).not.toBeNull();
    expect(host.querySelector("textarea")!.placeholder).toBe("Message Juniper while it works");
  });

  it("sends and never stops on a click meant to send while the dog works", async () => {
    await mount(true, "also the small phone");
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-composer-send]")!.click(); });
    expect(actions()).toContain("send");
    expect(actions()).not.toContain("interrupt");
  });

  it("sends and never stops on Enter while the dog works", async () => {
    await mount(true, "also the small phone");
    const textarea = host.querySelector("textarea")!;
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(actions()).toContain("send");
    expect(actions()).not.toContain("interrupt");
  });

  it("stops only from the stop disc with an empty field", async () => {
    await mount(true);
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-composer-stop]")!.click(); });
    expect(actions()).toEqual(["interrupt"]);
  });

  it("draws the composer as one surface", async () => {
    await mount(false);
    expect(host.querySelectorAll("[data-composer-surface]")).toHaveLength(1);
  });
});

describe("the usage row in the composer", () => {
  const report = (usedPercent: number) => ({
    fetchedAt: "2026-11-17T09:00:00Z",
    providers: [{
      id: "claude", name: "Claude", driver: "claudeAgent", plan: "max", ok: true, error: null, extra: [],
      weekly: { available: true, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: "2026-11-20T09:00:00Z" },
      fiveHour: { available: true, usedPercent: 10, remainingPercent: 90, resetsAt: "2026-11-17T15:00:00Z" },
    }],
  });
  const withUsage = async (usedPercent: number) => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(report(usedPercent)), { status: 200, headers: { "content-type": "application/json" } })));
    await reloadPlanUsage(true);
  };

  it("grows a top row inside the surface at 75 % that opens the usage view", async () => {
    await withUsage(75);
    await mount(false);
    const surface = host.querySelector("[data-composer-surface]")!;
    expect(surface.firstElementChild?.hasAttribute("data-usage-notice")).toBe(true);
    expect(surface.querySelector("[data-usage-notice]")!.textContent).toBe("Most of this week's use is gone");
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-usage-notice-open]")!.click(); });
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toContainEqual({ type: "toggleAppSettings", open: true, section: "usage" });
  });

  it("shows no row at 74 %", async () => {
    await withUsage(74);
    await mount(false);
    expect(host.querySelector("[data-usage-notice]")).toBeNull();
  });
});

describe("stopping while the dog waits on a card", () => {
  const permission = { id: "p1", role: "bot", kind: "options", at: 1, card: { title: "Approval needed", subtitle: "pnpm test", options: ["Allow", "Deny"], tool: "Bash", requestId: "req-permission" } } as Bot["messages"][number];
  const question = { id: "q1", role: "bot", kind: "options", at: 1, card: { title: "Question", subtitle: "", options: [], requestId: "req-question", requestType: "question",
    questionRequest: { version: 1, questions: [{ question: "Which photo should lead the menu?", options: [{ label: "The lemon tart" }, { label: "The garden salad" }] }] } } } as Bot["messages"][number];

  it("keeps the stop disc while a permission card waits, and stops the turn as its × did", async () => {
    await mount(true, "", [permission]);
    expect(endSlot()).toEqual(["mic", "stop"]);
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-composer-stop]")!.click(); });
    expect(actions()).toEqual(["interrupt"]);
  });

  it("keeps the stop disc while a question waits, and ends the wait as its × did", async () => {
    await mount(true, "", [question]);
    expect(endSlot()).toEqual(["mic", "stop"]);
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-composer-stop]")!.click(); });
    const decided = fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "decideRequest");
    expect(decided).toEqual([expect.objectContaining({ requestId: "req-question", behavior: "answer", message: QUESTION_DISMISS_MESSAGE })]);
    expect(actions()).not.toContain("interrupt");
  });

  it("holds send, not stop, once there is a draft while a card waits", async () => {
    await mount(true, "Around noon", [question]);
    expect(endSlot()).toEqual(["send"]);
  });
});
