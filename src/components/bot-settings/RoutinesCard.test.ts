import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Routine, RoutineRun } from "@/lib/routines";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 800 });
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    values: [] as unknown[],
    index: 0,
    own: 0,
    dispatch: (() => {}) as (...args: unknown[]) => void,
    storeState: {} as Record<string, unknown>,
    drafts: [] as { id: string; text: string }[],
  };
});
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
vi.mock("react-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-dom")>(),
  createPortal: (node: ReactNode) => node,
}));
vi.mock("@/lib/drafts", () => ({
  appendComposerDraft: (id: string, text: string) => fixture.drafts.push({ id, text }),
  getDraft: (_store: unknown, id: string) =>
    fixture.drafts.filter((draft) => draft.id === id).map((draft) => draft.text).join("\n\n"),
}));
vi.mock("@/state/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/state/store")>();
  return {
    ...store,
    useStore: () => ({
      state: { ...store.initialState, ...fixture.storeState },
      dispatch: fixture.dispatch,
    }),
  };
});

const { RoutinesCard } = await import("./RoutinesCard");
const { ConfirmDialog } = await import("../ConfirmDialog");

afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}

function capture(component: () => ReactNode) {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = component();
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", soul: "",
  notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
};

const card = (forBot: Bot = bot) => capture(() => RoutinesCard({ bot: forBot }));
const find = (rendered: { nodes: Node[] }, attr: string, value: unknown = true) =>
  rendered.nodes.find((node) => node.props[attr] === value)!;
const click = (node: Node) => (node.props.onClick as () => void)();
const pressRow = (rendered: { nodes: Node[] }, id: string) =>
  (find(rendered, "data-routine", id).props.onClick as (event: unknown) => void)({
    currentTarget: { getBoundingClientRect: () => ({ left: 40, bottom: 120 }) },
  });

const routine = (id: string, extra: Partial<Routine> = {}): Routine => ({
  id, name: `Routine ${id}`, prompt: "Check the inbox", target: "bot", botId: "scout", runOn: "dog", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: null, createdAt: 0, updatedAt: 0,
  ...extra,
});

beforeEach(() => {
  fixture.values = [];
  fixture.index = 0;
  fixture.own = 0;
  fixture.dispatch = vi.fn();
  fixture.storeState = { routinesLoadState: "ready" };
  fixture.drafts = [];
});

describe("the routines card", () => {
  it("waits for routines to load, says when the load failed, and explains when the dog has none", () => {
    fixture.storeState = { routinesLoadState: "loading" };
    expect(card().html).toContain("Loading routines…");
    const failed = { routines: { id: 1, line: "Couldn't load routines", retryable: true } };
    fixture.storeState = { routinesLoadState: "error", paneErrors: failed };
    const rendered = card();
    expect(rendered.html).toContain('data-pane-error="routines"');
    expect(rendered.html).toContain("Couldn&#x27;t load routines");
    expect(rendered.html).toContain("Try again");
    expect(rendered.html).not.toContain("Loading routines…");
    fixture.storeState = { routinesLoadState: "error", paneErrors: {} };
    expect(card().html).toContain("Loading routines…");
    fixture.storeState = { routinesLoadState: "error", paneErrors: failed, routines: [routine("soon")] };
    const stale = card();
    expect(stale.html).toContain("Couldn&#x27;t load routines");
    expect(stale.html).toContain("Routine soon");
    fixture.storeState = { routinesLoadState: "ready" };
    expect(card().html).toContain("Ask Scout to do something every morning, or every Friday, and it shows up here.");
  });

  it("lists only this dog's routines, running ones first and soonest first, with their schedule", () => {
    fixture.storeState = { routinesLoadState: "ready", routines: [
      routine("napping", { enabled: false }),
      routine("later", { nextRunAt: 2_000 }),
      routine("strays", { botId: "rex", nextRunAt: 500 }),
      routine("soon", { nextRunAt: 1_000 }),
    ] };
    const rendered = card();
    const rows = rendered.nodes.filter((node) => node.props["data-routine"] !== undefined);
    expect(rows.map((node) => node.props["data-routine"])).toEqual(["soon", "later", "napping"]);
    expect(rendered.html).toContain("Routine soon");
    expect(rendered.html).toContain("Every weekday at");
    expect(rendered.html).toContain("Paused");
  });

  it("pauses and resumes straight from the switch", () => {
    fixture.storeState = { routinesLoadState: "ready", routines: [routine("soon"), routine("napping", { enabled: false })] };
    const rendered = card();
    click(find(rendered, "aria-label", "Pause or resume Routine soon"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateRoutine", routineId: "soon", patch: { enabled: false } });
    click(find(rendered, "aria-label", "Pause or resume Routine napping"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateRoutine", routineId: "napping", patch: { enabled: true } });
  });

  it("opens an actions menu under the row, pauses from it, and closes on Escape", () => {
    fixture.storeState = { routinesLoadState: "ready", routines: [routine("soon"), routine("napping", { enabled: false })] };
    expect(card().nodes.some((node) => node.props.role === "menu")).toBe(false);
    pressRow(card(), "soon");
    const open = card();
    expect(find(open, "data-routine", "soon").props["aria-expanded"]).toBe(true);
    const menu = find(open, "role", "menu");
    expect(menu.props["aria-label"]).toBe("Actions for Routine soon");
    expect(menu.props.style).toEqual({ left: 40, top: 124 });
    expect(Children.toArray((find(open, "data-routine-action", "pause").props.children as ReactNode[]))).toContain("Pause");
    click(find(open, "data-routine-action", "pause"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateRoutine", routineId: "soon", patch: { enabled: false } });
    expect(card().nodes.some((node) => node.props.role === "menu")).toBe(false);

    pressRow(card(), "napping");
    const paused = card();
    expect(Children.toArray((find(paused, "data-routine-action", "pause").props.children as ReactNode[]))).toContain("Resume");
    (find(paused, "role", "menu").props.onKeyDown as (event: unknown) => void)({
      key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn(),
    });
    expect(card().nodes.some((node) => node.props.role === "menu")).toBe(false);
  });

  it("runs a routine now from the top of its menu and closes the menu", () => {
    fixture.storeState = { routinesLoadState: "ready", routines: [routine("soon"), routine("napping", { enabled: false })] };
    pressRow(card(), "napping");
    const open = card();
    const actions = open.nodes.filter((node) => node.props.role === "menuitem").map((node) => node.props["data-routine-action"]);
    expect(actions).toEqual(["run", "pause", "edit", "delete"]);
    expect(Children.toArray((find(open, "data-routine-action", "run").props.children as ReactNode[]))).toContain("Run now");
    click(find(open, "data-routine-action", "run"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "runRoutine", routineId: "napping" });
    expect(card().nodes.some((node) => node.props.role === "menu")).toBe(false);
  });

  it("turns Edit into a chat draft once and hands the person back to the composer", () => {
    fixture.storeState = { routinesLoadState: "ready", routines: [routine("soon")] };
    pressRow(card(), "soon");
    click(find(card(), "data-routine-action", "edit"));
    expect(fixture.drafts).toEqual([{ id: "bot:scout:thread-scout", text: "Change my routine “Routine soon”: " }]);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: false });
    pressRow(card(), "soon");
    click(find(card(), "data-routine-action", "edit"));
    expect(fixture.drafts).toHaveLength(1);
  });

  it("shows the last run under each routine and opens it in the dog's conversation", () => {
    const run = (id: string, routineId: string, createdAt: number, status: RoutineRun["status"]): RoutineRun => ({
      id, routineId, routineName: `Routine ${routineId}`, target: "bot", botId: "scout", runOn: "dog",
      scheduledFor: createdAt, status, manual: false, createdAt,
    });
    fixture.storeState = { routinesLoadState: "ready", routines: [routine("soon"), routine("fresh")], routineRuns: [
      run("old", "soon", Date.UTC(2026, 9, 16, 16), "failed"),
      run("new", "soon", Date.UTC(2026, 9, 17, 16), "completed"),
      run("unseen", "fresh", Date.UTC(2026, 9, 17, 17), "running"),
    ] };
    const withRows: Bot = { ...bot, messages: [
      { id: "m-old", role: "bot", kind: "routine.run", text: "", at: 1, routineRun: { runId: "old", routineId: "soon", routineName: "Routine soon", status: "failed" } },
      { id: "m-new", role: "bot", kind: "routine.run", text: "", at: 2, routineRun: { runId: "new", routineId: "soon", routineName: "Routine soon", status: "completed" } },
    ] } as Bot;
    const rendered = card(withRows);
    const line = find(rendered, "data-routine-last-run", "new");
    expect(line.type).toBe("button");
    expect(line.props.children).toMatch(/^Last run .+ · Completed$/);
    const focus = { type: "focusMessage", threadId: "thread-scout", messageId: "m-new" };
    const wide = (matches: boolean) => Object.assign(window, { matchMedia: (query: string) => ({ matches: matches && query === "(min-width: 768px)" }) });
    wide(true);
    click(line);
    expect(fixture.dispatch).toHaveBeenLastCalledWith(focus);
    wide(false);
    click(line);
    expect(vi.mocked(fixture.dispatch).mock.calls.slice(-2)).toEqual([[focus], [{ type: "toggleSettings", open: false }]]);
    expect(rendered.nodes.some((node) => node.props["data-routine-last-run"] === "old")).toBe(false);
    const elsewhere = find(rendered, "data-routine-last-run", "unseen");
    expect(elsewhere.type).toBe("div");
    expect(elsewhere.props.children).toMatch(/ · Running$/);

    fixture.storeState = { routinesLoadState: "ready", routines: [routine("soon")], routineRuns: [] };
    expect(card().nodes.some((node) => node.props["data-routine-last-run"] !== undefined)).toBe(false);
  });

  it("asks before deleting and only deletes on confirm", () => {
    fixture.storeState = { routinesLoadState: "ready", routines: [routine("soon")] };
    pressRow(card(), "soon");
    click(find(card(), "data-routine-action", "delete"));
    const confirm = card().nodes.find((node) => node.type === ConfirmDialog)!;
    expect(confirm.props).toMatchObject({ open: true, title: "Delete routine?", confirmLabel: "Delete" });
    expect(confirm.props.body).toBe("“Routine soon” will stop running and be deleted. This cannot be undone.");
    (confirm.props.onCancel as () => void)();
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "deleteRoutine" }));

    pressRow(card(), "soon");
    click(find(card(), "data-routine-action", "delete"));
    const reopened = card().nodes.find((node) => node.type === ConfirmDialog)!;
    (reopened.props.onConfirm as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "deleteRoutine", routineId: "soon" });
    expect((card().nodes.find((node) => node.type === ConfirmDialog)!.props as { open: boolean }).open).toBe(false);
  });
});
