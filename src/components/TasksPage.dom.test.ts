// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import type { TaskView } from "@/state/task-view";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(async () => ({})), state: {} as { bots: Bot[]; taskView: TaskView | null; tasksOpen: boolean } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), api: fixture.api }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("./ChatView", async () => {
  const { createElement: element } = await import("react");
  return { ChatView: ({ bot }: { bot: Bot }) => element("div", { "data-chat-thread": bot.threadId, "data-chat-messages": bot.messages.length }) };
});
import { TasksPage } from "./TasksPage";

const opener = { botId: "olive", name: "Olive", at: 1 };
const olive = {
  id: "olive", name: "Olive", threadId: "main", messages: [],
  tasks: [
    { threadId: "main", title: "Olive", createdAt: 0 },
    { threadId: "flights", title: "Book flights", createdAt: Date.now(), openedBy: opener, busy: true },
    { threadId: "visa", title: "Check the visa", createdAt: Date.now(), openedBy: opener, activity: "waiting-on-you" },
  ],
} as unknown as Bot;

let host: HTMLDivElement;
let root: Root;

function show(state: Partial<typeof fixture.state>) {
  fixture.state = { bots: [olive], taskView: null, tasksOpen: true, ...state };
  act(() => root.render(createElement(TasksPage)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.dispatch.mockReset();
  fixture.api.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the Tasks page", () => {
  it("lists the dogs' tasks by state, the one that needs you first, and opens one", () => {
    show({});
    expect([...host.querySelectorAll("[data-task-section]")].map((section) => section.getAttribute("data-task-section"))).toEqual(["needsYou", "working"]);
    expect(host.textContent).toContain("Needs you");
    expect(host.textContent).toContain("Check the visa");
    act(() => host.querySelector<HTMLButtonElement>('[data-task-row="flights"]')!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "openTask", botId: "olive", threadId: "flights" });
    act(() => host.querySelector<HTMLButtonElement>('[data-task-row="visa"] ~ [data-task-done="done"]')!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "markTaskDone", botId: "olive", threadId: "visa", done: true });
  });

  it("says how tasks start when there are none", () => {
    show({ bots: [{ ...olive, tasks: [] } as Bot] });
    expect(host.textContent).toContain("Ask a dog for several things at once and it starts each one as a task you can follow here.");
  });

  it("shows an open task's own conversation, who started it, and takes the person back", () => {
    show({ taskView: { botId: "olive", threadId: "flights", messages: [{ id: "m1", role: "user", kind: "text", text: "Find flights", at: 1 }], hasMore: false, activeLeafId: "m1", loading: false, failed: false } });
    expect(host.querySelector("[data-chat-thread]")!.getAttribute("data-chat-thread")).toBe("flights");
    expect(host.querySelector("[data-chat-thread]")!.getAttribute("data-chat-messages")).toBe("1");
    expect(host.textContent).toContain("Olive started this task");
    act(() => [...host.querySelectorAll("button")].find((button) => button.textContent === "Back to Tasks")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "closeTask" });
  });

  it("marks an open task read when a reply comes in while the person is looking at it", () => {
    const replied = { ...olive, tasks: olive.tasks!.map((task) => (task.threadId === "flights" ? { ...task, busy: false, unread: true } : task)) } as Bot;
    show({ bots: [replied], taskView: { botId: "olive", threadId: "flights", messages: [], hasMore: false, activeLeafId: null, loading: false, failed: false } });
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/olive/read", { method: "POST", body: JSON.stringify({ threadId: "flights" }) });
  });
});
