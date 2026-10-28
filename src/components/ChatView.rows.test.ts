// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

const renders = vi.hoisted(() => ({ botText: 0, userText: 0, toolChip: 0 }));
const guest = vi.hoisted(() => ({ canWrite: true as boolean | null }));
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
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => guest.canWrite }));
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

  it("shows React, Copy and Reply on hover, plus Edit on the person's messages, with View source under More on answers only", () => {
    const row = (mid: string) => [...document.querySelectorAll(`[data-mid="${mid}"] [data-testid="message-actions"] > button`)]
      .map((button) => button.getAttribute("aria-label"));
    expect(row("m5")).toEqual([t("chat.reaction.open"), t("chat.copyMessage"), t("chat.replyToMessage")]);
    expect(row("m3")).toEqual([t("chat.editMessage"), t("chat.reaction.open"), t("chat.copyMessage"), t("chat.replyToMessage")]);
    expect(document.querySelectorAll(`[data-mid="m3"] [aria-label="${t("chat.messageActions")}"]`)).toHaveLength(0);
    expect(document.querySelectorAll(`[data-mid="m5"] [aria-label="${t("chat.messageActions")}"]`).length).toBeGreaterThan(0);
  });

  it("shows a reaction made on the phone under its bubble", async () => {
    const answer = messages.find((candidate) => candidate.id === "m5")!;
    await rowRendersAfter((current) => reducer(current, {
      type: "messagePatched", threadId: "pepper-thread", message: { ...answer, reactions: [{ emoji: "👍", by: "user" }, { emoji: "👍", by: "pepper" }] },
    }));
    const pill = document.querySelector<HTMLButtonElement>('[data-mid="m5"] [data-testid="reaction-pills"] button')!;
    expect(pill.textContent).toBe("👍2");
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(pill.getAttribute("aria-label")).toBe(t("chat.reaction.by", { names: `${t("chat.reaction.you")} and pepper`, emoji: "👍" }));
    expect(document.querySelectorAll('[data-mid="m3"] [data-testid="reaction-pills"]')).toHaveLength(0);
  });

  it("reacts from the picker and posts the reaction to the home", async () => {
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    dispatch.mockClear();
    flushSync(() => document.querySelector<HTMLButtonElement>(`[data-mid="m3"] [aria-label="${t("chat.reaction.open")}"]`)!.click());
    const picker = document.querySelector('[data-testid="reaction-picker"]')!;
    expect([...picker.querySelectorAll("button")].map((button) => button.textContent || button.getAttribute("aria-label")))
      .toEqual(["👍", "👎", "❤️", "😂", "🎉", t("chat.reaction.more")]);
    flushSync(() => picker.querySelector<HTMLButtonElement>(`[aria-label="${t("chat.reaction.add", { emoji: "🎉" })}"]`)!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "reactionsSet", threadId: "pepper-thread", messageId: "m3", reactions: [{ emoji: "🎉", by: "user" }] });
    expect(fetch).toHaveBeenCalledWith("/api/threads/pepper-thread/messages/m3/reactions", expect.objectContaining({ method: "POST", body: JSON.stringify({ emoji: "🎉" }) }));
  });

  it("searches the full emoji list from More", async () => {
    flushSync(() => document.querySelector<HTMLButtonElement>(`[data-mid="m3"] [aria-label="${t("chat.reaction.open")}"]`)!.click());
    const picker = () => document.querySelector('[data-testid="reaction-picker"]:not([aria-hidden])')!;
    flushSync(() => picker().querySelector<HTMLButtonElement>(`[aria-label="${t("chat.reaction.more")}"]`)!.click());
    const search = picker().querySelector<HTMLInputElement>("input")!;
    expect(document.activeElement).toBe(search);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => {
      setValue.call(search, "rocket");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...picker().querySelectorAll('[role="group"] button')].map((button) => button.textContent)).toEqual(["🚀"]);
  });

  it("lets a Cloud guest see reactions in a chat that is not theirs, but not add or change one", async () => {
    guest.canWrite = false;
    try {
      await draw();
      expect(document.querySelectorAll(`[data-mid] [aria-label="${t("chat.reaction.open")}"]`)).toHaveLength(0);
      const pill = document.querySelector<HTMLButtonElement>('[data-mid="m5"] [data-testid="reaction-pills"] button')!;
      expect(pill.textContent).toBe("👍2");
      expect(pill.disabled).toBe(true);
      const fetch = vi.fn(() => new Promise(() => {}));
      vi.stubGlobal("fetch", fetch);
      dispatch.mockClear();
      flushSync(() => pill.click());
      expect(dispatch).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      guest.canWrite = true;
      await draw();
    }
  });
});
