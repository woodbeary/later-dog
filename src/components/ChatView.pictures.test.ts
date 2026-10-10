// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");

const picture = (id: string) => `<attached-image path="/store/${id}.png" name="${id.slice(0, 3)}.png" />`;

const message = (id: string, parentId: string | undefined, fields: Partial<Message>): Message =>
  ({ id, parentId, role: "user", kind: "text", at: new Date(2026, 9, 10, 9, Number(id.slice(1))).getTime(), ...fields });

const messages: Message[] = [
  message("m1", undefined, { text: `hi there\n\n${picture("123e4567-e89b-42d3-a456-426614174000")}\n\n${picture("223e4567-e89b-42d3-a456-426614174000")}` }),
  message("m2", "m1", { role: "bot", text: "Nice colours." }),
  message("m3", "m2", { text: picture("323e4567-e89b-42d3-a456-426614174000") }),
  message("m4", "m3", { role: "bot", text: "Another one?" }),
  message("m5", "m4", { text: picture("423e4567-e89b-42d3-a456-426614174000"), replyToId: "m4" }),
];

const pepper: Bot = {
  id: "pepper", threadId: "pepper-thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: "m5", modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
};

const state: AppState = {
  ...initialState,
  connected: true,
  selectedId: "pepper",
  bots: [pepper],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
};

let root: Root;
const row = (id: string) => document.querySelector<HTMLElement>(`[data-mid='${id}']`)!;
const pictures = (id: string) => row(id).querySelector<HTMLElement>("[data-sent-attachments]")!;
const bubble = (id: string) => row(id).querySelector<HTMLElement>("[data-chat-bubble]")!;
const before = (first: Node, second: Node) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeAll(async () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot: pepper }) })));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("pictures you send", () => {
  it("sit in their own right-aligned row above the words, outside the bubble", () => {
    expect(pictures("m1").closest("[data-chat-bubble]")).toBeNull();
    expect(pictures("m1").parentElement!.classList.contains("items-end")).toBe(true);
    expect(pictures("m1").classList.contains("items-end")).toBe(true);
    expect(before(pictures("m1"), bubble("m1"))).toBe(true);
    expect(pictures("m1").querySelectorAll("[data-sent-pictures] > div")).toHaveLength(2);
  });

  it("leave the bubble holding only the words, so it is as wide as they are", () => {
    expect(bubble("m1").textContent).toBe("hi there");
    expect(bubble("m1").classList.contains("w-fit")).toBe(true);
    expect(bubble("m1").querySelector("img")).toBeNull();
  });

  it("are never stretched to a fixed width", () => {
    for (const id of ["m1", "m3", "m5"]) expect(pictures(id).className).not.toContain("34rem");
  });

  it("show on their own, with no bubble, when there are no words", () => {
    expect(bubble("m3").contains(pictures("m3"))).toBe(true);
    expect(bubble("m3").classList.contains("bg-bubble-user")).toBe(false);
    expect(bubble("m3").querySelector(".chat-text")).toBeNull();
  });

  it("stay with the quoted message when they are a reply without words", () => {
    expect(bubble("m5").classList.contains("bg-bubble-user")).toBe(true);
    expect(bubble("m5").contains(pictures("m5"))).toBe(true);
    expect(bubble("m5").textContent).toContain("Another one?");
    const quote = [...bubble("m5").querySelectorAll("*")].find((element) => element.textContent === "Another one?")!;
    expect(before(quote, pictures("m5"))).toBe(true);
  });
});
