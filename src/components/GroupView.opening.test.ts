// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group, InstanceInfo, Message } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { GroupView } = await import("./GroupView");
const { BotEditorStore, initialState } = await import("@/state/store");

const at = (row: number) => new Date(2026, 9, 3, 9, 0).getTime() + row * 60_000;
const answers = (row: number) => row % 2 === 1;
const message = (row: number): Message => ({
  id: `m${row}`,
  role: answers(row) ? "bot" : "user",
  kind: "text",
  at: at(row),
  text: `Row ${row}`,
  from: answers(row) ? { botId: "pepper", name: "Pepper", color: "green" } : undefined,
});
const thread = (count: number): Message[] => Array.from({ length: count }, (_, row) => message(row));

const pepper: Bot = {
  id: "pepper", threadId: "pepper-thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
};
const room = (messages: Message[]): Group => ({
  id: "room", threadId: "room-thread", name: "Standup", memberIds: ["pepper"],
  defaultResponder: { kind: "member", botId: "pepper" }, bulletin: "", unread: false,
  createdAt: 1, setupCompletedAt: 1, messages,
});

let root: Root;
let host: HTMLDivElement;
let frames: FrameRequestCallback[];

async function draw(messages: Message[]) {
  const group = room(messages);
  const state: AppState = {
    ...initialState,
    connected: true,
    selectedId: "room",
    bots: [pepper],
    groups: [group],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
    config: { features: { showToolCalls: false } } as AppState["config"],
  };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  await act(async () => root.render(createElement(BotEditorStore, { value, children: createElement(GroupView, { group }) })));
}

async function frame() {
  await act(async () => {
    const queued = frames;
    frames = [];
    for (const run of queued) run(performance.now());
  });
}

const rowIds = () => [...host.querySelectorAll("[data-mid]")].map((row) => row.getAttribute("data-mid"));
const newLineRow = () => host.querySelector("[data-unread-divider]")?.closest("[data-mid]")?.getAttribute("data-mid") ?? null;
const newLines = () => host.querySelectorAll("[data-unread-divider]").length;
const readUpTo = (row: number) => localStorage.setItem("laterdog-seen-at", JSON.stringify({ "room/room/room-thread": at(row) }));

async function fill() {
  const steps = [rowIds().length];
  for (let step = 0; step < 6 && steps.at(-1)! < 120; step++) {
    await frame();
    steps.push(rowIds().length);
  }
  return steps;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 3, 23, 0));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  frames = [];
  const asked = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    asked.set(asked.size + 1, run);
    frames.push(run);
    return asked.size;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    frames = frames.filter((run) => run !== asked.get(handle));
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a long group chat opening on its newest rows", () => {
  it("opens on the whole window when the New line belongs above the newest rows, so the line never moves", async () => {
    readUpTo(100);
    await draw(thread(150));
    expect(rowIds()).toHaveLength(120);
    expect(newLineRow()).toBe("m101");
    expect(newLines()).toBe(1);
    await frame();
    expect(rowIds()).toHaveLength(120);
    expect(newLineRow()).toBe("m101");
    expect(newLines()).toBe(1);
  });

  it("still opens on the newest rows when everything unread is among them, and the New line stays on its row as the rest fills in", async () => {
    readUpTo(140);
    await draw(thread(150));
    expect(rowIds()).toHaveLength(30);
    expect(newLineRow()).toBe("m141");
    expect(await fill()).toEqual([30, 60, 90, 120]);
    expect(newLineRow()).toBe("m141");
    expect(newLines()).toBe(1);
  });

  it("opens a group chat with nothing unread on its newest rows and draws no New line", async () => {
    readUpTo(149);
    await draw(thread(150));
    expect(rowIds()).toHaveLength(30);
    expect(newLines()).toBe(0);
    expect(await fill()).toEqual([30, 60, 90, 120]);
    expect(newLines()).toBe(0);
  });
});
