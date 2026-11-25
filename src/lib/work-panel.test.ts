// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  backWorkPanel,
  closeWorkPanel,
  openWorkPanel,
  useWorkPanel,
  useWorkPanelOpen,
  workPanelCanGoBack,
  workPanelOpener,
  type WorkPanelPage,
} from "./work-panel";

let root: Root;
let host: HTMLDivElement;
let seen: Array<WorkPanelPage | null> = [];
let openSeen: boolean[] = [];
function OpenProbe() {
  openSeen.push(useWorkPanelOpen());
  return null;
}
function Probe() {
  seen.push(useWorkPanel());
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  seen = [];
  openSeen = [];
});
afterEach(() => {
  act(() => {
    closeWorkPanel();
    root.unmount();
  });
  host.remove();
});

it("opens a page, shows it to every reader, and closes to nothing", async () => {
  await act(async () => root.render(createElement(Probe)));
  expect(seen.at(-1)).toBeNull();
  await act(async () => openWorkPanel({ kind: "work", threadId: "t1" }));
  expect(seen.at(-1)).toEqual({ kind: "work", threadId: "t1" });
  await act(async () => closeWorkPanel());
  expect(seen.at(-1)).toBeNull();
});

it("pushes a step or a side job over its chat's page and goes back to it, but a new chat starts fresh", async () => {
  await act(async () => root.render(createElement(Probe)));
  await act(async () => openWorkPanel({ kind: "work", threadId: "t1" }));
  await act(async () =>
    openWorkPanel({ kind: "step", threadId: "t1", runId: "r1", activityId: "a1" }),
  );
  expect(workPanelCanGoBack()).toBe(true);
  await act(async () => backWorkPanel());
  expect(seen.at(-1)).toEqual({ kind: "work", threadId: "t1" });
  expect(workPanelCanGoBack()).toBe(false);
  await act(async () => openWorkPanel({ kind: "side-jobs", threadId: "t1" }));
  await act(async () => openWorkPanel({ kind: "side-job", threadId: "t2", jobId: "j1" }));
  expect(workPanelCanGoBack()).toBe(false);
});

it("tells layout readers only when the panel opens or closes", async () => {
  await act(async () => root.render(createElement(OpenProbe)));
  expect(openSeen).toEqual([false]);
  await act(async () => openWorkPanel({ kind: "work", threadId: "t1" }));
  expect(openSeen).toEqual([false, true]);
  await act(async () =>
    openWorkPanel({ kind: "step", threadId: "t1", runId: "r1", activityId: "a1" }),
  );
  await act(async () => backWorkPanel());
  await act(async () => openWorkPanel({ kind: "side-jobs", threadId: "t1" }));
  expect(openSeen).toEqual([false, true]);
  await act(async () => closeWorkPanel());
  expect(openSeen).toEqual([false, true, false]);
});

it("keeps the opening control through panel navigation and close, then remembers the next opener", async () => {
  const first = document.createElement("button");
  const second = document.createElement("button");
  document.body.append(first, second);
  try {
    first.focus();
    await act(async () => openWorkPanel({ kind: "work", threadId: "t1" }));
    expect(workPanelOpener()).toBe(first);
    second.focus();
    await act(async () =>
      openWorkPanel({ kind: "step", threadId: "t1", runId: "r1", activityId: "a1" }),
    );
    await act(async () => backWorkPanel());
    expect(workPanelOpener()).toBe(first);
    await act(async () => closeWorkPanel());
    expect(workPanelOpener()).toBe(first);
    await act(async () => openWorkPanel({ kind: "work", threadId: "t2" }));
    expect(workPanelOpener()).toBe(second);
  } finally {
    first.remove();
    second.remove();
  }
});
