// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const at = (minute: number) => new Date(2026, 9, 3, 9, minute).getTime();
const message = (id: string, minute: number, fields: Partial<Message>): Message =>
  ({ id, parentId: minute > 0 ? `m${minute - 1}` : undefined, role: "bot", kind: "text", at: at(minute), ...fields });
const transcript: Message[] = [
  message("m0", 0, { role: "user", text: "Find me a flight" }),
  message("m1", 1, { kind: "activity", tool: { name: "Search flights", ok: true } }),
  message("m2", 2, { text: "Three options under $300." }),
  message("m3", 3, { role: "user", text: "Book the cheapest" }),
  message("m4", 4, { kind: "activity", tool: { name: "Open airline site", ok: true } }),
  message("m5", 5, { text: "Booked. Confirmation sent to your email." }),
];

const pepper: Bot = {
  id: "pepper", threadId: "pepper-thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: transcript, activeLeafId: "m5", modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
};

let root: Root;
let host: HTMLDivElement;

function draw(showToolCalls: boolean) {
  const state: AppState = {
    ...initialState,
    connected: true,
    selectedId: "pepper",
    bots: [pepper],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
    config: { features: { showToolCalls } } as AppState["config"],
  };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot: pepper }) })));
}

const dividers = () => [...host.querySelectorAll("[data-unread-divider]")];
const dividerRow = () => dividers()[0]?.closest("[data-mid]")?.getAttribute("data-mid");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 3, 23, 0));
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the New line in a chat", () => {
  it("sits above the first reply the person has not seen, skipping steps that stay hidden", () => {
    localStorage.setItem("laterdog-seen-at", JSON.stringify({ "pepper/pepper-thread": at(2) }));
    draw(false);
    expect([...host.querySelectorAll("[data-mid]")].map((row) => row.getAttribute("data-mid"))).toEqual(["m0", "m2", "m3", "m5"]);
    expect(dividers()).toHaveLength(1);
    expect(dividerRow()).toBe("m5");
    expect(dividers()[0]!.textContent).toBe("New");
  });

  it("sits above the first visible step when tool calls are shown", () => {
    localStorage.setItem("laterdog-seen-at", JSON.stringify({ "pepper/pepper-thread": at(2) }));
    draw(true);
    expect(dividers()).toHaveLength(1);
    expect(dividerRow()).toBe("m4");
  });

  it("is not drawn on a first visit or when everything was already seen", () => {
    draw(false);
    expect(dividers()).toHaveLength(0);
    flushSync(() => root.unmount());
    root = createRoot(host);
    draw(false);
    expect(dividers()).toHaveLength(0);
  });
});
