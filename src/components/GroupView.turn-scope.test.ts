// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./DesktopCapabilities")>()),
  useDesktopCapabilities: () => ({
    capabilities: {
      dictation: { available: false },
      host: { packaged: true, platform: "other" },
      localComputer: { available: false },
    },
    ready: true,
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { GroupView } = await import("./GroupView");
const { BotEditorStore, initialState } = await import("@/state/store");
const { api } = await import("@/lib/api");
const { forgetNativeRuns, loadNativeRuns } = await import("@/lib/native-runs-state");
const now = new Date(2026, 10, 25, 12).getTime();
const scout: Bot = {
  id: "scout",
  threadId: "private-thread",
  name: "Scout",
  title: "",
  description: "",
  color: "green",
  notifications: true,
  unread: false,
  busy: false,
  activity: "idle",
  work: { kind: "idle" },
  modelSelection: { instanceId: "test", model: "test" },
  messages: [],
};
const room: Group = {
  id: "room",
  threadId: "room-thread",
  name: "The shop",
  memberIds: ["scout"],
  defaultResponder: { kind: "member", botId: "scout" },
  bulletin: "",
  unread: false,
  createdAt: 1,
  working: false,
  work: { kind: "idle" },
  messages: [],
};
let root: Root;
let host: HTMLDivElement;
async function draw(group = room, bots = [scout]) {
  const state: AppState = { ...initialState, selectedId: group.id, bots, groups: [group] };
  const value = {
    state,
    dispatch: vi.fn(),
    flushBotPatches: async () => null,
    refreshInstances: async () => {},
    refreshModels: async () => {},
  };
  await act(async () =>
    root.render(
      createElement(BotEditorStore, { value, children: createElement(GroupView, { group }) }),
    ),
  );
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({ runs: [] });
  localStorage.clear();
  forgetNativeRuns();
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

describe("room turn ownership", () => {
  it("does not borrow a member's private-chat approval wait in an idle room", async () => {
    await draw(room, [
      {
        ...scout,
        busy: true,
        activity: "waiting-on-you",
        work: { kind: "needs-you", what: "Private approval" },
      },
    ]);
    expect(host.querySelector("[data-turn-slot]")).toBeNull();
    expect(host.textContent).not.toContain("Waiting for your OK");
  });

  it("keeps room work visible when its busy speaker privately waits for approval", async () => {
    await draw(
      {
        ...room,
        working: true,
        busyBotId: scout.id,
        turnStartedAt: now - 120_000,
        work: { kind: "running" },
      },
      [
        {
          ...scout,
          busy: true,
          activity: "waiting-on-you",
          work: { kind: "needs-you", what: "Private approval" },
        },
      ],
    );
    expect(host.querySelector("[data-turn-slot] button")).not.toBeNull();
    expect(host.querySelector("[data-turn-slot]")?.textContent).not.toContain(
      "Waiting for your OK",
    );
  });

  it("uses the room's current reading activity instead of a member's private editing step", async () => {
    const privateDog = {
      ...scout,
      busy: true,
      activity: "working" as const,
      step: {
        id: "private-edit",
        kind: "editing" as const,
        startedAt: now - 120_000,
        lastActivityAt: now,
      },
    };
    await draw(
      {
        ...room,
        working: true,
        busyBotId: scout.id,
        turnStartedAt: now - 120_000,
        work: { kind: "running" },
        messages: [
          {
            id: "room-read",
            role: "bot",
            kind: "activity",
            at: now - 120_000,
            tool: { name: "Read" },
            from: { botId: scout.id, name: scout.name, color: scout.color },
          },
        ],
      },
      [privateDog],
    );
    expect(host.querySelector("[data-work-line-phrase]")?.textContent).toMatch(
      /Doing some reading|Reading it through|Going through it/,
    );
  });

  it("does not choose a room speaker because another member's private work needs approval", async () => {
    const fern: Bot = {
      ...scout,
      id: "fern",
      name: "Fern",
      threadId: "fern-private",
      activity: "waiting-on-you",
      work: { kind: "needs-you", what: "Private approval" },
    };
    await draw(
      {
        ...room,
        memberIds: [scout.id, fern.id],
        working: true,
        turnStartedAt: now - 120_000,
        work: { kind: "running" },
      },
      [scout, fern],
    );
    expect(host.querySelector("[data-turn-slot] button")?.getAttribute("aria-label")).toMatch(
      /^Scout:/,
    );
  });

  it("keeps an approval wait authored by the room visible", async () => {
    await draw({ ...room, work: { kind: "needs-you", what: "Room approval" } });
    expect(host.querySelector("[data-turn-slot]")?.textContent).toContain("Waiting for your OK");
  });
});

describe("room history availability", () => {
  it("shows incomplete history in an idle room without retained runs or any work opener", async () => {
    vi.mocked(api).mockResolvedValue({ runs: [], historyIncomplete: true });
    await draw();
    expect(
      host.querySelector("[data-turn-slot], [data-fold-line], [data-native-work-fallbacks]"),
    ).toBeNull();
    expect(host.textContent).toContain("Some earlier work is no longer available.");
  });

  it("keeps the known incomplete-history warning after a refresh fails", async () => {
    vi.mocked(api).mockResolvedValue({ runs: [], historyIncomplete: true });
    await draw();
    vi.mocked(api).mockRejectedValueOnce(new Error("Work history is unavailable."));
    await act(async () => loadNativeRuns(room.threadId, { refresh: true }));
    expect(host.textContent).toContain("Some earlier work is no longer available.");
  });

  it("does not carry an incomplete-history notice into another room", async () => {
    vi.mocked(api).mockResolvedValueOnce({ runs: [], historyIncomplete: true });
    await draw();
    expect(host.textContent).toContain("Some earlier work is no longer available.");
    await draw({ ...room, id: "other-room", threadId: "other-room-thread" });
    expect(host.textContent).not.toContain("Some earlier work is no longer available.");
  });
});
