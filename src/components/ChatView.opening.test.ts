// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeRun } from "../../shared/native-runs";
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
const { forgetNativeRuns, receiveNativeRun } = await import("@/lib/native-runs-state");

const at = (row: number) => new Date(2026, 9, 3, 9, 0).getTime() + row * 60_000;
const answers = (row: number) => row % 2 === 1;
const message = (row: number): Message => ({
  id: `m${row}`,
  parentId: row > 0 ? `m${row - 1}` : undefined,
  role: answers(row) ? "bot" : "user",
  kind: "text",
  at: at(row),
  text: `Row ${row}`,
  turnId: answers(row) ? `turn${row}` : undefined,
});
const thread = (count: number): Message[] => Array.from({ length: count }, (_, row) => message(row));
const finishedRun = (row: number): NativeRun => ({
  id: `run${row}`, threadId: "pepper-thread", turnId: `turn${row}`, provider: "claudeAgent", revision: 1,
  startedAt: at(row) - 1_000, endedAt: at(row), state: "done", observation: "complete",
  actors: [{ id: "parent", kind: "parent", label: "Main", state: "done", startedAt: at(row) - 1_000 }],
  activityCount: 0, failureCount: 0, limitations: [],
});

const pepper = (messages: Message[]): Bot => ({
  id: "pepper", threadId: "pepper-thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages, activeLeafId: messages.at(-1)?.id, modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
});

let root: Root;
let host: HTMLDivElement;
let frames: FrameRequestCallback[];

async function draw(messages: Message[]) {
  const bot = pepper(messages);
  const state: AppState = {
    ...initialState,
    connected: true,
    selectedId: "pepper",
    bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
    config: { features: { showToolCalls: false } } as AppState["config"],
  };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  await act(async () => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
}

async function frame() {
  await act(async () => {
    const queued = frames;
    frames = [];
    for (const run of queued) run(performance.now());
  });
}

const rowIds = () => [...host.querySelectorAll("[data-mid]")].map((row) => row.getAttribute("data-mid"));
const earlierWork = () => host.querySelector("[data-native-work-fallbacks] summary")?.textContent ?? null;
const newLineRow = () => host.querySelector("[data-unread-divider]")?.closest("[data-mid]")?.getAttribute("data-mid") ?? null;
const readUpTo = (row: number) => localStorage.setItem("laterdog-seen-at", JSON.stringify({ "pepper/pepper-thread": at(row) }));
const arrivingIds = () => [...host.querySelectorAll("[data-arriving]")].map((row) => row.getAttribute("data-mid"));

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
  forgetNativeRuns();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a long chat opening on its newest rows", () => {
  it("shows the same earlier-work line at every step of the fill", async () => {
    const messages = thread(150);
    for (const row of messages) if (row.turnId) receiveNativeRun(finishedRun(Number(row.id.slice(1))));
    await draw(messages);
    expect(rowIds()).toHaveLength(30);
    const lines = [earlierWork()];
    for (let step = 0; step < 6 && rowIds().length < 120; step++) {
      await frame();
      lines.push(earlierWork());
    }
    expect(rowIds()).toHaveLength(120);
    expect(lines).toEqual(["Earlier work · 15", "Earlier work · 15", "Earlier work · 15", "Earlier work · 15"]);
  });

  it("opens on the whole window when the New line belongs above the newest rows, so the line never moves", async () => {
    readUpTo(100);
    await draw(thread(150));
    expect(rowIds()).toHaveLength(120);
    expect(newLineRow()).toBe("m101");
    await frame();
    expect(rowIds()).toHaveLength(120);
    expect(newLineRow()).toBe("m101");
  });

  it("still opens on the newest rows when everything unread is among them", async () => {
    readUpTo(140);
    await draw(thread(150));
    expect(rowIds()).toHaveLength(30);
    expect(newLineRow()).toBe("m141");
    await fill();
    expect(rowIds()).toHaveLength(120);
    expect(newLineRow()).toBe("m141");
  });

  it("slides in only rows that are newer than the ones the chat opened on", async () => {
    const messages = thread(150);
    await draw(messages);
    expect(await fill()).toEqual([30, 60, 90, 120]);
    expect(rowIds()[0]).toBe("m30");
    expect(arrivingIds()).toEqual([]);

    await draw([...messages, message(150), message(151)]);
    expect(arrivingIds()).toEqual(["m150", "m151"]);
  });
});
