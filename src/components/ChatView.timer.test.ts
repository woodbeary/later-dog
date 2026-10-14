// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");

let host: HTMLDivElement;
let root: Root;
const bot = (): Bot => ({
  id: "first-dog", threadId: "first-chat", name: "Biscuit", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: true, activity: "working",
  modelSelection: { instanceId: "test", model: "m" },
  messages: [{ id: "ask", role: "user", kind: "text", text: "Help me get started", at: 996_000 }],
  activeLeafId: "ask",
  tasks: [{ threadId: "first-chat", title: "First chat", createdAt: 995_000, busy: true, activity: "working", turnStartedAt: 997_000, workingStartedAt: 997_000 }],
});
const draw = async (profile: Bot) => {
  const state = { ...initialState, bots: [profile], selectedId: profile.id,
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  await act(async () => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot: profile }) })));
};
const settleRow = () => act(async () => { await new Promise((done) => setTimeout(done, 350)); });
const timer = async () => {
  const trigger = host.querySelector<HTMLButtonElement>('.turn-presence button[aria-haspopup="dialog"]');
  expect(trigger).toBeTruthy();
  if (trigger?.getAttribute("aria-expanded") !== "true") await act(async () => trigger?.click());
  return document.querySelector('[role="dialog"] .tabular-nums')?.textContent;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the progress peek timer", () => {
  it("counts from the resumed answer after a long question wait, including after reopening the chat", async () => {
    const profile = bot();
    await draw(profile);
    expect(await timer()).toBe("3s");
    const waiting = { ...profile, activity: "waiting-on-you" as const,
      tasks: profile.tasks!.map((task) => ({ ...task, activity: "waiting-on-you" as const, workingStartedAt: undefined })) };
    vi.setSystemTime(1_003_000);
    await draw(waiting);
    const resumed = { ...profile, tasks: profile.tasks!.map((task) => ({ ...task, workingStartedAt: 1_046_000 })) };
    vi.setSystemTime(1_049_000);
    await draw(resumed);
    await settleRow();
    expect(await timer()).toBe("3s");
    expect(resumed.tasks![0]!.turnStartedAt).toBe(997_000);
    await act(async () => root.unmount());
    root = createRoot(host);
    vi.setSystemTime(1_051_000);
    await draw(resumed);
    expect(await timer()).toBe("5s");
  });

  it("keeps the original turn timer when an older server sends no working timestamp", async () => {
    const profile = bot();
    await draw({ ...profile, tasks: profile.tasks!.map((task) => ({ ...task, workingStartedAt: undefined })) });
    expect(await timer()).toBe("3s");
  });
});
