// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: fixture.dispatch }) }));
import { ChatHeaderTasks } from "./ChatHeaderTasks";

const opener = { botId: "olive", name: "Olive", at: 1 };
const now = Date.now();
const olive = {
  id: "olive", name: "Olive", threadId: "main", messages: [],
  tasks: [
    { threadId: "main", title: "Olive", createdAt: 0 },
    { threadId: "flights", title: "Book flights", createdAt: now - 3, openedBy: opener, busy: true },
    { threadId: "visa", title: "Check the visa", createdAt: now - 2, openedBy: opener, activity: "waiting-on-you" },
    { threadId: "hotel", title: "Find a hotel", createdAt: now - 1, openedBy: opener, archivedAt: now - 1 },
  ],
} as unknown as Bot;

let host: HTMLDivElement;
let root: Root;

async function show(bot: Bot) {
  await act(async () => root.render(createElement(ChatHeaderTasks, { bot })));
}

const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
const rows = () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-label])')];
const row = (text: string) => rows().find((element) => element.textContent?.startsWith(text));
const press = async (element: HTMLElement | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => element!.click());
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.reducedMotion = "true";
  setLocale("en");
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete document.documentElement.dataset.reducedMotion;
  vi.unstubAllGlobals();
});

describe("the Tasks button in a dog's chat header", () => {
  it("lists the dog's tasks with the one that needs you first, and opens one", async () => {
    await show(olive);
    expect(trigger()!.getAttribute("aria-label")).toBe("Tasks, 1 for you");
    expect(host.querySelector("[data-chat-tasks]")!.getAttribute("data-chat-tasks")).toBe("1");
    await press(trigger());
    expect(rows().map((element) => element.textContent)).toEqual(["Check the visaNeeds you", "Book flightsWorking", "Show done tasks"]);
    await press(row("Book flights"));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "openTask", botId: "olive", threadId: "flights" });
  });

  it("marks a task done right from the list", async () => {
    await show(olive);
    await press(trigger());
    await press(host.querySelector<HTMLButtonElement>('[aria-label="Mark as done"]'));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "markTaskDone", botId: "olive", threadId: "visa", done: true });
  });

  it("keeps done tasks behind Show done tasks, where they can be reopened", async () => {
    await show(olive);
    await press(trigger());
    expect(row("Find a hotel")).toBeUndefined();
    await press(row("Show done tasks"));
    expect(row("Find a hotel")!.textContent).toBe("Find a hotelDone");
    expect(row("Hide done tasks")).toBeTruthy();
    await press(host.querySelector<HTMLButtonElement>('[aria-label="Reopen"]'));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "markTaskDone", botId: "olive", threadId: "hotel", done: false });
  });

  it("shows nothing for a dog that hasn't started a task", async () => {
    await show({ ...olive, tasks: [{ threadId: "main", title: "Olive", createdAt: 0 }] } as Bot);
    expect(host.innerHTML).toBe("");
  });
});
