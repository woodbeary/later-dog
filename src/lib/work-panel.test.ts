// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backWorkPanel, closeWorkPanel, openWorkPanel, useWorkPanel, workPanelCanGoBack, type WorkPanelPage } from "./work-panel";

let root: Root;
let host: HTMLDivElement;
let seen: Array<WorkPanelPage | null> = [];
function Probe() { seen.push(useWorkPanel()); return null; }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  seen = [];
});
afterEach(() => { act(() => { closeWorkPanel(); root.unmount(); }); host.remove(); });

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
  await act(async () => openWorkPanel({ kind: "step", threadId: "t1", runId: "r1", activityId: "a1" }));
  expect(workPanelCanGoBack()).toBe(true);
  await act(async () => backWorkPanel());
  expect(seen.at(-1)).toEqual({ kind: "work", threadId: "t1" });
  expect(workPanelCanGoBack()).toBe(false);
  await act(async () => openWorkPanel({ kind: "side-jobs", threadId: "t1" }));
  await act(async () => openWorkPanel({ kind: "side-job", threadId: "t2", jobId: "j1" }));
  expect(workPanelCanGoBack()).toBe(false);
});
