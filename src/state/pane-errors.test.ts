import { describe, expect, it, vi } from "vitest";

import {
  PANE_NOTICE_MS,
  afterPaneRefresh,
  chatPane,
  createPaneErrorReporter,
  dogPanelPane,
  paneErrorsFor,
  withPaneError,
  withoutPaneError,
  type PaneErrorAction,
  type PaneErrors,
} from "./pane-errors";
import { dogChangePane, initialState, reducer, revertGroupPatch, selectedPane, shownPaneOr, type AppState, type Bot, type Group } from "./store";

const line = (id: number, retryable = true) => ({ id, line: `problem ${id}`, retryable });

const everyPane: PaneErrors = {
  sidebar: line(1),
  routines: line(2),
  dogPanel: line(3),
  [chatPane("thread-a")]: line(4),
  [dogPanelPane("scout")]: line(5),
  plugins: line(6),
};

describe("pane errors", () => {
  it("keep one line per pane and clear only the line they were asked to", () => {
    const errors = withPaneError(withPaneError({}, "sidebar", line(1)), chatPane("t"), line(2));
    expect(paneErrorsFor(errors, [chatPane("t"), "sidebar"])).toEqual({ pane: "chat:t", error: line(2) });
    expect(withoutPaneError(errors, "sidebar", 9)).toBe(errors);
    expect(withoutPaneError(errors, "sidebar", 1)).toEqual({ "chat:t": line(2) });
    expect(withoutPaneError(errors, "routines")).toBe(errors);
  });

  it("clear after the refresh that owns each pane succeeds", () => {
    expect(Object.keys(afterPaneRefresh(everyPane, "chat")).sort()).toEqual(["dogPanel", "routines"]);
    expect(Object.keys(afterPaneRefresh(everyPane, "routines")).sort()).toEqual(["chat:thread-a", "dogPanel", "dogPanel:scout", "plugins", "sidebar"]);
    expect(Object.keys(afterPaneRefresh(everyPane, "models")).sort()).toEqual(["chat:thread-a", "dogPanel:scout", "plugins", "routines", "sidebar"]);
    const routinesOnly: PaneErrors = { routines: line(2) };
    expect(afterPaneRefresh(routinesOnly, "chat")).toBe(routinesOnly);
  });
});

describe("the pane error reporter", () => {
  const harness = (fallback: "sidebar" | `chat:${string}` = "sidebar") => {
    const actions: PaneErrorAction[] = [];
    const timers: Array<{ run: () => void; ms: number }> = [];
    let errors: PaneErrors = {};
    const reporter = createPaneErrorReporter({
      dispatch: (action) => {
        actions.push(action);
        errors = action.type === "paneError"
          ? withPaneError(errors, action.pane, action.error)
          : withoutPaneError(errors, action.pane, action.id);
      },
      fallbackPane: () => fallback,
      schedule: (run, ms) => timers.push({ run, ms }),
    });
    return { reporter, actions, timers, errors: () => errors };
  };

  it("words the error plainly and puts it in the pane that failed", () => {
    const { reporter, errors } = harness();
    reporter.report(new TypeError("Failed to fetch"), chatPane("t"), { retry: () => {} });
    expect(errors()).toEqual({
      "chat:t": { id: 1, line: "Couldn't reach later.dog. Check that it's running and that you're online, then try again.", retryable: true },
    });
  });

  it("uses the open chat when no pane is named", () => {
    const { reporter, errors } = harness(chatPane("open"));
    reporter.report(new Error("Not now"));
    expect(Object.keys(errors())).toEqual(["chat:open"]);
  });

  it("keeps a line with Try again until it is retried, and the retry clears it before it runs again", () => {
    const { reporter, timers, errors } = harness();
    const retry = vi.fn(() => {
      expect(errors().sidebar).toBeUndefined();
      reporter.report(new Error("Still down"), "sidebar", { retry });
    });
    reporter.report(new Error("Went down"), "sidebar", { line: "Couldn't refresh", retry });
    expect(timers).toEqual([]);
    expect(errors().sidebar).toEqual({ id: 1, line: "Couldn't refresh", retryable: true });
    reporter.retry("sidebar");
    expect(retry).toHaveBeenCalledTimes(1);
    expect(errors().sidebar).toEqual({ id: 2, line: "Still down", retryable: true });
  });

  it("does nothing when a pane has nothing to retry", () => {
    const { reporter, actions } = harness();
    reporter.retry("routines");
    expect(actions).toEqual([]);
  });

  it("lets a line with nothing to retry go after a short while, unless a newer line replaced it", () => {
    const { reporter, timers, errors } = harness();
    reporter.report(new Error("That model can't read pictures"), chatPane("t"));
    expect(timers.map((timer) => timer.ms)).toEqual([PANE_NOTICE_MS]);
    reporter.report(new Error("Newer problem"), chatPane("t"), { retry: () => {} });
    timers[0]!.run();
    expect(errors()["chat:t"]?.line).toBe("Newer problem");
    reporter.report(new Error("Short notice"), "routines");
    timers[1]!.run();
    expect(errors().routines).toBeUndefined();
  });
});

describe("the store keeps pane errors", () => {
  const bot = { id: "scout", threadId: "thread-scout", messages: [], tasks: [] } as unknown as Bot;
  const withErrors: AppState = { ...initialState, bots: [bot], selectedId: "scout", paneErrors: everyPane };

  it("sets and clears a pane's line", () => {
    const set = reducer(initialState, { type: "paneError", pane: "sidebar", error: line(7) });
    expect(set.paneErrors).toEqual({ sidebar: line(7) });
    expect(reducer(set, { type: "paneErrorCleared", pane: "sidebar", id: 6 })).toBe(set);
    expect(reducer(set, { type: "paneErrorCleared", pane: "sidebar", id: 7 }).paneErrors).toEqual({});
  });

  it("clears the sidebar, chat and dog panel lines when the chat snapshot comes back", () => {
    const next = reducer(withErrors, { type: "hydrate", bots: [bot], groups: [], computerControl: {} });
    expect(Object.keys(next.paneErrors).sort()).toEqual(["dogPanel", "routines"]);
  });

  it("clears the routines line when routines load, and the shared dog panel line when models or settings load", () => {
    expect(Object.keys(reducer(withErrors, { type: "routinesHydrated", routines: [], runs: [] }).paneErrors)).not.toContain("routines");
    expect(Object.keys(reducer(withErrors, { type: "instances", instances: [] }).paneErrors)).not.toContain("dogPanel");
    expect(Object.keys(reducer(withErrors, { type: "configStatus", config: null as never }).paneErrors)).not.toContain("dogPanel");
  });

  it("does not keep a global error line", () => {
    expect(Object.keys(initialState)).not.toContain("error");
    expect(initialState.paneErrors).toEqual({});
  });

  it("names the open chat as the pane for errors that do not say where they belong", () => {
    expect(selectedPane(withErrors)).toBe("chat:thread-scout");
    expect(selectedPane({ ...withErrors, selectedId: "" })).toBe("chat:thread-scout");
    expect(selectedPane({ ...withErrors, selectedId: "gone" })).toBe("chat:thread-scout");
    expect(selectedPane({ ...withErrors, bots: [], selectedId: "" })).toBe("sidebar");
  });

  it("files a failed dog change where it is on screen", () => {
    expect(dogChangePane(withErrors, "scout")).toBe("chat:thread-scout");
    expect(dogChangePane({ ...withErrors, settingsOpen: true }, "scout")).toBe("dogPanel:scout");
    expect(dogChangePane({ ...withErrors, settingsOpen: true }, "other")).toBe("chat:thread-scout");
    expect(dogChangePane({ ...withErrors, pluginsOpen: true }, "scout")).toBe("plugins");
    expect(dogChangePane({ ...withErrors, selectedId: "" }, "scout")).toBe("chat:thread-scout");
    expect(dogChangePane({ ...withErrors, selectedId: "", settingsOpen: true }, "scout")).toBe("dogPanel:scout");
    expect(dogChangePane({ ...withErrors, bots: [], selectedId: "" }, "scout")).toBe("sidebar");
  });

  it("files a failed change to a conversation that is not open in the one that is", () => {
    const room = { id: "room", threadId: "thread-room", memberIds: ["scout"], messages: [] } as unknown as Group;
    const both = { ...withErrors, groups: [room] };
    expect(shownPaneOr(both, "chat:thread-room")).toBe("chat:thread-scout");
    expect(shownPaneOr({ ...both, selectedId: "room" }, "chat:thread-room")).toBe("chat:thread-room");
    expect(shownPaneOr(both, undefined)).toBe("chat:thread-scout");
  });

  it("puts a room's old values back when its change fails, but keeps a newer change", () => {
    const room = { id: "room", threadId: "thread-room", name: "Renamed", section: "Work", memberIds: [], messages: [] } as unknown as Group;
    expect(revertGroupPatch(room, { name: "Renamed" }, { name: "Room" }).name).toBe("Room");
    expect(revertGroupPatch(room, { name: "Older" }, { name: "Room" })).toBe(room);
    const failed = reducer({ ...withErrors, groups: [room] }, { type: "groupPatchFailed", groupId: "room", patch: { name: "Renamed", section: "Later" }, previous: { name: "Room", section: "Home" } });
    expect(failed.groups[0]).toMatchObject({ name: "Room", section: "Work" });
  });

  it("alerts the mascot only for a line in the open chat", () => {
    const open = reducer(withErrors, { type: "paneError", pane: chatPane("thread-scout"), error: line(8) });
    expect(open.mascotMotion?.botId).toBe("scout");
    const elsewhere = reducer(withErrors, { type: "paneError", pane: chatPane("thread-other"), error: line(9) });
    expect(elsewhere.mascotMotion).toBe(withErrors.mascotMotion);
    expect(elsewhere.paneErrors["chat:thread-other"]).toEqual(line(9));
  });
});
