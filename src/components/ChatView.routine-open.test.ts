import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { RoutineRun } from "../../shared/routines";

const view = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { bots: [] as Bot[], routineRuns: [] as RoutineRun[] };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: {
      ...original.initialState,
      bots: view.bots,
      routineRuns: view.routineRuns,
      instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo],
    },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());

const runCard = (executionThreadId: string): Message => ({
  id: "run-card", role: "bot", kind: "routine.run", at: 1_000, text: "Morning brief completed.",
  routineRun: { runId: "run-1", routineId: "routine-1", routineName: "Morning brief", status: "completed", executionThreadId },
});
const dog = (patch: Partial<Bot>): Bot => ({
  id: "pepper", threadId: "pepper-main", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "pepper-main", title: "Main", createdAt: 1 }, { threadId: "pepper-old-run", title: "Morning brief", createdAt: 2, routineRunId: "run-1" }],
  ...patch,
});
const render = (bot: Bot, others: Bot[] = []) => {
  view.bots = [bot, ...others];
  return renderToStaticMarkup(createElement(ChatView, { bot }));
};

describe("routine controls in a dog's one conversation", () => {
  it("shows no Open run button on an old run card whose run task belongs to the same dog", () => {
    const messages = [runCard("pepper-old-run")];
    const markup = render(dog({ messages, activeLeafId: "run-card" }));
    expect(markup).toContain("Morning brief");
    expect(markup).not.toContain("Open run");
  });

  it("offers Open run when another dog's one conversation is the run", () => {
    const messages = [runCard("biscuit-main")];
    const biscuit = dog({ id: "biscuit", threadId: "biscuit-main", name: "Biscuit", tasks: [] });
    const markup = render(dog({ messages, activeLeafId: "run-card" }), [biscuit]);
    expect(markup).toContain("Open run");
  });

  it("shows no Back to results button when the results are another task of the same dog", () => {
    view.routineRuns = [{ id: "run-1", threadId: "pepper-old-run", sourceThreadId: "pepper-main", routineName: "Morning brief" } as RoutineRun];
    try {
      const markup = render(dog({ threadId: "pepper-old-run" }));
      expect(markup).toContain("Run details");
      expect(markup).not.toContain("Back to results");
    } finally {
      view.routineRuns = [];
    }
  });

  it("offers Back to results when the results are another dog's one conversation", () => {
    view.routineRuns = [{ id: "run-1", threadId: "pepper-old-run", sourceThreadId: "biscuit-main", routineName: "Morning brief" } as RoutineRun];
    try {
      const biscuit = dog({ id: "biscuit", threadId: "biscuit-main", name: "Biscuit", tasks: [] });
      const markup = render(dog({ threadId: "pepper-old-run" }), [biscuit]);
      expect(markup).toContain("Back to results");
    } finally {
      view.routineRuns = [];
    }
  });
});
