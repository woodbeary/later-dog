// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

const renders = vi.hoisted(() => ({ botText: 0, userText: 0, toolChip: 0 }));
vi.mock("./ChatMarkdown", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ChatMarkdown")>(),
  ChatMarkdown: ({ text }: { text: string }) => {
    renders.botText++;
    return createElement("p", null, text);
  },
}));
vi.mock("./MentionText", async (importOriginal) => ({
  ...await importOriginal<typeof import("./MentionText")>(),
  MentionText: ({ text, faces }: { text: string; faces?: boolean }) => {
    if (faces) renders.userText++;
    return createElement("span", null, text);
  },
}));
vi.mock("./ToolActivity", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ToolActivity")>(),
  ToolActivity: ({ tool }: { tool: { name: string } }) => {
    renders.toolChip++;
    return createElement("span", null, tool.name);
  },
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState, reducer } = await import("@/state/store");
const { t } = await import("@/lib/i18n");

const message = (id: string, parentId: string | undefined, fields: Partial<Message>): Message =>
  ({ id, parentId, role: "bot", kind: "text", at: new Date(2026, 9, 3, 9, Number(id.slice(1))).getTime(), ...fields });
const messages: Message[] = [];
for (let turn = 0; turn < 3; turn++) {
  const at = turn * 3;
  messages.push(
    message(`m${at}`, messages.at(-1)?.id, { role: "user", text: `Question ${turn}` }),
    message(`m${at + 1}`, `m${at}`, { kind: "activity", tool: { name: `Read file ${turn}`, ok: turn < 2 ? true : undefined } }),
  );
  if (turn < 2) messages.push(message(`m${at + 2}`, `m${at + 1}`, { text: `Answer ${turn}` }));
}
const running = messages.at(-1)!;

const profile = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: `${id}-thread`, title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
  ...extra,
});

let state: AppState = {
  ...initialState,
  connected: true,
  selectedId: "pepper",
  bots: [profile("pepper", { messages, activeLeafId: running.id }), profile("scout")],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
  config: { features: { showToolCalls: true } } as AppState["config"],
};
const dispatch = vi.fn();
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw() {
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const children = createElement(ChatView, { bot: state.bots.find((bot) => bot.id === "pepper")! });
  flushSync(() => root.render(createElement(BotEditorStore, { value, children })));
  await settle();
}
function moreMenus() {
  const menus: Record<string, string[]> = {};
  for (const trigger of document.querySelectorAll<HTMLButtonElement>(`[data-mid] button[aria-label="${t("chat.messageActions")}"]`)) {
    flushSync(() => trigger.click());
    const menu = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menu?.getAttribute("role")).toBe("menu");
    expect(menu?.getAttribute("aria-label")).toBe(t("chat.messageActions"));
    expect(trigger.closest("[data-mid]")!.contains(menu)).toBe(false);
    const items = menu!.querySelectorAll('[role="menuitem"]');
    menus[trigger.closest("[data-mid]")!.getAttribute("data-mid")!] = [...items].map((item) => item.textContent ?? "");
    flushSync(() => trigger.click());
  }
  return menus;
}
const offering = (label: string) => Object.entries(moreMenus()).filter(([, items]) => items.includes(label)).map(([mid]) => mid);
async function rowRendersAfter(change: (current: AppState) => AppState) {
  renders.botText = renders.userText = renders.toolChip = 0;
  state = change(state);
  await draw();
  return { ...renders };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 3, 23, 0));
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await draw();
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chat transcript rows", () => {
  it("draws every row once on mount", () => {
    expect(document.querySelectorAll("[data-mid]")).toHaveLength(messages.length);
    expect(document.body.textContent).toContain("Today");
    expect(document.body.textContent).toContain("Answer 1");
    expect(document.body.textContent).toContain("Read file 2");
  });

  it("renders no row when another bot changes", async () => {
    const scout = state.bots.find((bot) => bot.id === "scout")!;
    expect(await rowRendersAfter((current) => reducer(current, { type: "botPatched", bot: { ...scout, busy: true } })))
      .toEqual({ botText: 0, userText: 0, toolChip: 0 });
  });

  it("renders no row when this bot changes in a way no row shows", async () => {
    expect(await rowRendersAfter((current) => {
      const { messages: _transcript, ...frame } = current.bots.find((bot) => bot.id === "pepper")!;
      return reducer(current, { type: "botPatched", bot: { ...frame, turnStartedAt: 5, tasks: frame.tasks?.map((task) => ({ ...task, updatedAt: 99 })) } });
    })).toEqual({ botText: 0, userText: 0, toolChip: 0 });
  });

  it("renders only the tool chip that changed", async () => {
    expect(await rowRendersAfter((current) => reducer(current, {
      type: "messagePatched", threadId: "pepper-thread", message: { ...running, tool: { name: "Read file 2, page 2" } },
    }))).toEqual({ botText: 0, userText: 0, toolChip: 1 });
    expect(document.body.textContent).toContain("Read file 2, page 2");
  });

  it("moves Today on to Yesterday after midnight, at the next store event", async () => {
    vi.setSystemTime(new Date(2026, 9, 4, 0, 30));
    const scout = state.bots.find((bot) => bot.id === "scout")!;
    await rowRendersAfter((current) => reducer(current, { type: "botPatched", bot: { ...scout, unread: true } }));
    expect(document.body.textContent).toContain("Yesterday");
    expect(document.body.textContent).not.toContain("Today");
  });

  it("shows Copy, a treat and Reply on hover, with the rest under More", () => {
    const row = (mid: string) => [...document.querySelectorAll(`[data-mid="${mid}"] [data-testid="message-actions"] > button`)]
      .map((button) => button.getAttribute("aria-label"));
    expect(row("m5")).toEqual([t("chat.copyMessage"), t("chat.giveTreat", { name: "pepper" }), t("chat.replyToMessage")]);
    expect(row("m3")).toEqual([t("chat.editMessage"), t("chat.copyMessage"), t("chat.replyToMessage")]);
    expect(moreMenus()).toMatchObject({
      m3: [t("chat.action.pin")],
      m5: [t("chat.action.viewSource"), t("chat.retry"), t("chat.action.pin")],
    });
  });

  it("offers Retry on the last answer only, and not during a turn", async () => {
    const regenerate = () => offering(t("chat.retry"));
    expect(regenerate()).toEqual(["m5"]);
    const busy = (value: boolean) => (current: AppState) => {
      const { messages: _transcript, ...frame } = current.bots.find((bot) => bot.id === "pepper")!;
      const tasks = frame.tasks?.map((task) => ({ ...task, busy: value, activity: value ? "working" as const : "idle" as const }));
      return reducer(current, { type: "botPatched", bot: { ...frame, busy: value, tasks } });
    };
    await rowRendersAfter(busy(true));
    expect(regenerate()).toEqual([]);
    await rowRendersAfter(busy(false));
    expect(regenerate()).toEqual(["m5"]);
  });

  it("offers Read aloud only once the voice engine has a voice", async () => {
    const speak = () => offering(t("chat.action.readAloud"));
    const voice = (configured: boolean) => (current: AppState) => reducer(current, {
      type: "configStatus",
      config: { ...current.config, tts: { configured, provider: "elevenlabs", voice: "fixture-voice" } } as NonNullable<AppState["config"]>,
    });
    try {
      await rowRendersAfter(voice(true));
      expect(speak()).toEqual(["m2", "m5"]);
      await rowRendersAfter(voice(false));
      expect(speak()).toEqual([]);
    } finally {
      await rowRendersAfter((current) => reducer(current, { type: "configStatus", config: { features: { showToolCalls: true } } as NonNullable<AppState["config"]> }));
    }
  });
});
