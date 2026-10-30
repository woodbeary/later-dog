// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import type { TaskView } from "@/state/task-view";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(async () => ({})), state: {} as { bots: Bot[] } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), api: fixture.api }));
vi.mock("./ChatView", async () => {
  const { createElement: element } = await import("react");
  return { ChatView: ({ bot }: { bot: Bot }) => element("div", { "data-chat-thread": bot.threadId, "data-chat-messages": bot.messages.length }) };
});
import { TaskChat } from "./TaskChat";

const opener = { botId: "olive", name: "Olive", at: 1 };
const olive = {
  id: "olive", name: "Olive", threadId: "main", messages: [],
  tasks: [
    { threadId: "main", title: "Olive", createdAt: 0 },
    { threadId: "flights", title: "Book flights", createdAt: Date.now(), openedBy: opener, busy: true },
  ],
} as unknown as Bot;

const view = (extra: Partial<TaskView> = {}): TaskView => ({
  botId: "olive", threadId: "flights", messages: [], hasMore: false, activeLeafId: null, loading: false, failed: false, ...extra,
});

let host: HTMLDivElement;
let root: Root;

function show(taskView: TaskView, bots: Bot[] = [olive]) {
  fixture.state = { bots };
  act(() => root.render(createElement(TaskChat, { view: taskView })));
}

const button = (text: string) => [...host.querySelectorAll("button")].find((element) => element.textContent === text);

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

describe("an open task", () => {
  it("shows the task's own conversation and who started it, and goes back to the dog", () => {
    show(view({ messages: [{ id: "m1", role: "user", kind: "text", text: "Find flights", at: 1 }], activeLeafId: "m1" }));
    expect(host.querySelector("[data-chat-thread]")!.getAttribute("data-chat-thread")).toBe("flights");
    expect(host.querySelector("[data-chat-thread]")!.getAttribute("data-chat-messages")).toBe("1");
    expect(host.textContent).toContain("Olive started this task");
    act(() => button("Back to Olive")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "closeTask" });
  });

  it("marks the task done from its top bar", () => {
    show(view());
    act(() => host.querySelector<HTMLButtonElement>('[data-task-done="done"]')!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "markTaskDone", botId: "olive", threadId: "flights", done: true });
  });

  it("marks an open task read when a reply comes in while the person is looking at it", () => {
    const replied = { ...olive, tasks: olive.tasks!.map((task) => (task.threadId === "flights" ? { ...task, busy: false, unread: true } : task)) } as Bot;
    show(view(), [replied]);
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/olive/read", { method: "POST", body: JSON.stringify({ threadId: "flights" }) });
  });

  it("says when the task is gone and still leads back to the dog", () => {
    show(view({ threadId: "gone" }));
    expect(host.textContent).toContain("This task is gone.");
    expect(button("Back to Olive")).toBeTruthy();
  });

  it("offers another try when the task couldn't open", () => {
    show(view({ failed: true }));
    expect(host.textContent).toContain("Couldn't open this task.");
    act(() => button("Try again")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "openTask", botId: "olive", threadId: "flights" });
  });
});
