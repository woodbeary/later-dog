// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Action, AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");
const { t } = await import("@/lib/i18n");

const message = (id: string, parentId: string | undefined, fields: Partial<Message>): Message =>
  ({ id, parentId, role: "user", kind: "text", at: new Date(2026, 9, 15, 13, Number(id.slice(1))).getTime(), ...fields });

const conversation: Message[] = [
  message("m1", undefined, { text: "look at this" }),
  message("m2", "m1", { role: "bot", text: "Nice colours." }),
  message("m3", "m2", { text: "and this?", replyToId: "m2" }),
  message("m4", "m3", { role: "bot", kind: "activity", tool: { name: "error: the engine stopped", ok: false } }),
];

const pepper = (messages: Message[], extra: Partial<Bot> = {}): Bot => ({
  id: "pepper", threadId: "pepper-thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: messages.at(-1)!.id, modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
  ...extra,
});

let host: HTMLDivElement;
let root: Root;
let dispatch: Mock<(action: Action) => void>;

const mount = async (messages: Message[], extra: Partial<Bot> = {}, pendingQueued: AppState["pendingQueued"] = {}) => {
  const bot = pepper(messages, extra);
  const state: AppState = {
    ...initialState,
    connected: true,
    selectedId: "pepper",
    bots: [bot],
    pendingQueued,
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" }, capabilities: { images: true } } as InstanceInfo],
  };
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  await act(async () => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
};
const row = (id: string) => host.querySelector<HTMLElement>(`[data-mid='${id}']`)!;
const composer = () => [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].at(-1)!;
const actions = () => dispatch.mock.calls.map(([action]) => action);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  dispatch = vi.fn<(action: Action) => void>();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("a dog's chat without the extras", () => {
  it("offers edit on sent messages and the up arrow opens the last one", async () => {
    await mount(conversation);
    expect(row("m3").querySelector(`button[aria-label="${t("chat.editMessage")}"]`)).not.toBeNull();
    await act(async () => composer().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(row("m3").querySelector("textarea")?.value).toBe("and this?");
    expect(actions()).toEqual([]);
  });

  it("keeps only the dog's pill, the account, the call chip, Find and More in the header", async () => {
    await mount(conversation);
    expect(host.querySelector(`button[title="${t("chat.computer")}"]`)).toBeNull();
    expect(host.querySelector('[data-testid="chat-more"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-find"]')?.getAttribute("aria-label")).toBe(t("chat.find"));
    expect(host.textContent).not.toContain("Pinned");
  });

  it("retries the last message as a new version after a failed turn", async () => {
    await mount(conversation);
    const retry = [...row("m4").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(t("chat.retry")))!;
    await act(async () => retry.click());
    expect(actions()).toEqual([expect.objectContaining({ type: "editMessage", botId: "pepper", threadId: "pepper-thread", messageId: "m3", text: "and this?" })]);
  });

  it("lists a message sent while the dog works above the message box, where it can be deleted", async () => {
    await mount(conversation.slice(0, 2), { busy: true }, { "pepper-thread": [{ queueId: "q1", text: "also check the logs" }] });
    const list = host.querySelector<HTMLElement>(`ul[aria-label="${t("composer.queued.list")}"]`)!;
    expect(list.textContent).toContain("also check the logs");
    await act(async () => list.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.queued.deleteAria", { index: 1, count: 1 })}"]`)!.click());
    expect(actions()).toEqual([{ type: "cancelQueued", botId: "pepper", threadId: "pepper-thread", queueId: "q1" }]);
  });
});
