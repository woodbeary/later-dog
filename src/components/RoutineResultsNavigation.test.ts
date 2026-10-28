import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";
import type { Routine, RoutineRun } from "@/lib/routines";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { state: undefined as AppState | undefined, dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.state ?? original.initialState, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { host: {}, dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { initialState } = await import("@/state/store");
const { EventDetails } = await import("./RoutineCalendarPage");

const bot: Bot = {
  id: "runner", threadId: "runner-chat", name: "Runner", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false,
  messages: [{ id: "run-message", role: "bot", kind: "routine.run", text: "", at: 150, routineRun: { runId: "run" } } as Bot["messages"][number]],
  modelSelection: { instanceId: "test", model: "test" },
};
const group: Group = {
  id: "room", threadId: "room-chat", name: "Team", memberIds: [bot.id],
  createdAt: 0, messages: [], unread: false, defaultResponder: { kind: "mentions" }, bulletin: "",
};
const routine: Routine = {
  id: "routine", name: "Daily report", prompt: "Report progress", target: "bot", botId: bot.id,
  runOn: "dog", enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1] },
  durationMinutes: 30, nextRunAt: 1_000, createdAt: 0, updatedAt: 2,
};
const run: RoutineRun = {
  id: "run", routineId: routine.id, routineName: routine.name, target: "bot", botId: bot.id,
  runOn: "dog", threadId: bot.threadId, scheduledFor: 100,
  createdAt: 100, finishedAt: 200, status: "completed", manual: false,
};

type Button = { children?: ReactNode; onClick?: () => void };
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Children.toArray(node).map((child) => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : textOf(child)).join("");
}

function buttonsFrom(render: () => ReactNode): Map<string, Button> {
  const buttons = new Map<string, Button>();
  function visit(node: ReactNode) {
    Children.forEach(node, (child) => {
      if (!isValidElement<Button>(child)) return;
      if (child.type === "button") buttons.set(textOf(child.props.children), child.props);
      visit(child.props.children);
    });
  }
  function Capture() { visit(render()); return null; }
  renderToStaticMarkup(createElement(Capture));
  return buttons;
}

function details(receipt: RoutineRun | null = run, definition: Routine | null = routine) {
  const onClose = vi.fn();
  const onOpenRoom = vi.fn();
  const buttons = buttonsFrom(() => EventDetails({
    item: { kind: "routine", id: receipt?.id ?? definition!.id, at: 100, durationMinutes: 30, routine: definition, run: receipt },
    bots: [bot], onClose, onEdit: vi.fn(), onCallChanged: vi.fn(), onOpenRoom,
  }));
  return { buttons, onClose, onOpenRoom };
}

beforeEach(() => {
  fixture.dispatch.mockClear();
  fixture.state = { ...initialState, bots: [bot], groups: [group], routines: [routine], routineRuns: [run] };
});
afterAll(() => vi.unstubAllGlobals());

describe("routine results navigation", () => {
  it("opens the dog's chat at the run's message", () => {
    const { buttons, onClose, onOpenRoom } = details();
    buttons.get("Open chat")!.onClick!();
    expect(onOpenRoom).toHaveBeenCalledWith(bot.id);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "focusMessage", threadId: bot.threadId, messageId: "run-message" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens the chat without jumping when the run left no message", () => {
    const { buttons, onOpenRoom } = details({ ...run, id: "other" });
    buttons.get("Open chat")!.onClick!();
    expect(onOpenRoom).toHaveBeenCalledWith(bot.id);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("opens the group chat for a group goal run", () => {
    const { buttons, onOpenRoom } = details({ ...run, target: "room-goal", groupId: group.id, threadId: group.threadId }, { ...routine, target: "room-goal", groupId: group.id });
    buttons.get("Open group chat")!.onClick!();
    expect(onOpenRoom).toHaveBeenCalledWith(group.id);
  });

  it("offers no chat link before the routine has run", () => {
    expect(details(null).buttons.has("Open chat")).toBe(false);
  });
});
