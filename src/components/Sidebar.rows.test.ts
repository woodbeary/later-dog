// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message, Task } from "@/state/store";

const renders = vi.hoisted(() => ({ bots: [] as string[] }));
vi.mock("./RenameTitle", () => ({
  RenameTitle: ({ value }: { value: string }) => {
    renders.bots.push(value);
    return createElement("span", null, value);
  },
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));

const { Sidebar } = await import("./Sidebar");
const { BotEditorStore, initialState, reducer } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 4, 12, 0).getTime();

const thread = (threadId: string, title: string, updatedAt: number): Task =>
  ({ threadId, title, createdAt: 1, updatedAt, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" });
const reply = (id: string, parentId: string | undefined, text: string): Message =>
  ({ id, parentId, role: "bot", kind: "text", text, at: NOW - HOUR });
const profile = (id: string, name: string, tasks: Task[], extra: Partial<Bot> = {}): Bot => ({
  id, threadId: tasks[0]!.threadId, name, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  tasks, ...extra,
});

const atlasMessages = [reply("a1", undefined, "Hello"), reply("a2", "a1", "Done with the report.")];
let state: AppState = {
  ...initialState,
  connected: true,
  selectedId: "atlas",
  bots: [
    profile("atlas", "Atlas", [
      thread("atlas-now", "Report draft", NOW - HOUR),
      thread("atlas-earlier", "Budget check", NOW - 2 * HOUR),
      thread("atlas-old", "Old notes", NOW - 30 * 24 * HOUR),
    ], { messages: atlasMessages, activeLeafId: "a2" }),
    profile("scout", "Scout", [thread("scout-now", "Scout plan", NOW - HOUR), thread("scout-earlier", "Scout list", NOW - 3 * HOUR)]),
    profile("pepper", "Pepper", [thread("pepper-now", "Pepper notes", NOW - HOUR)]),
  ],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
};
const dispatch = vi.fn();
let root: Root;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw() {
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(Sidebar, { open: true, onClose: () => {} }) })));
  await settle();
}
function counted() {
  const bots: Record<string, number> = {};
  for (const name of renders.bots) bots[name] = (bots[name] ?? 0) + 1;
  return bots;
}
async function rowRendersAfter(change: () => void | Promise<void>) {
  renders.bots = [];
  await change();
  await settle();
  return counted();
}
const update = (next: (current: AppState) => AppState) => async () => {
  state = next(state);
  await draw();
};
const bot = (id: string) => state.bots.find((candidate) => candidate.id === id)!;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  setLocale("en");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await draw();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setLocale("en");
});

describe("sidebar rows", () => {
  it("draws one row per dog and no thread rows for old extra tasks", () => {
    for (const id of ["atlas", "scout", "pepper"]) expect(document.querySelector(`[data-sidebar-bot-row="${id}"]`)).not.toBeNull();
    expect(document.querySelector("[data-sidebar-thread-row]")).toBeNull();
    for (const title of ["Report draft", "Budget check", "Old notes", "Scout list"]) expect(document.body.textContent).not.toContain(title);
    expect(document.body.textContent).toContain("Done with the report.");
  });

  it("renders no row for a store event no row shows", async () => {
    expect(await rowRendersAfter(update((current) => reducer(current, { type: "toggleSettings", open: true })))).toEqual({});
  });

  it("renders only the row of the dog that changed", async () => {
    expect(await rowRendersAfter(update((current) => reducer(current, { type: "botPatched", bot: { ...bot("scout"), busy: true } }))))
      .toEqual({ Scout: 1 });
  });

  it("renders only that dog's row for a new message", async () => {
    const message = { ...reply("a3", "a2", "One more thing."), at: NOW };
    expect(await rowRendersAfter(update((current) => reducer(current, { type: "messageAdded", threadId: "atlas-now", message }))))
      .toEqual({ Atlas: 1 });
  });

  it("renders no row on the clock's tick", async () => {
    expect(await rowRendersAfter(() => { vi.advanceTimersByTime(30_000); })).toEqual({});
  });

  it("moves the selection with exactly the two rows it changes", async () => {
    expect(await rowRendersAfter(update((current) => reducer(current, { type: "select", id: "scout" })))).toEqual({ Atlas: 1, Scout: 1 });
    expect(document.querySelector('[data-sidebar-bot-row="scout"]')?.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('[data-sidebar-bot-row="atlas"]')?.getAttribute("aria-current")).toBeNull();
  });

  it("re-renders every row when the app language changes", async () => {
    try {
      setLocale("de");
      expect(await rowRendersAfter(draw)).toEqual({ Atlas: 1, Scout: 1, Pepper: 1 });
    } finally {
      setLocale("en");
      await draw();
    }
  });
});
