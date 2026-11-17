// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FoldLine, SideJobsStillGoing } from "./FoldLine";
import { closeWorkPanel, useWorkPanel } from "@/lib/work-panel";

let root: Root;
let host: HTMLDivElement;
let opened: unknown = null;
function PanelProbe() {
  opened = useWorkPanel();
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  closeWorkPanel();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("reads as one grey sentence with a chevron and opens what the dog did", () => {
  act(() => root.render(createElement("div", null, createElement(FoldLine, { threadId: "jt", runId: "run-9", sentence: "Made 2 changes, tried 3 things" }), createElement(PanelProbe))));
  const line = host.querySelector<HTMLButtonElement>("button[data-fold-line]")!;
  expect(line.textContent).toBe("Made 2 changes, tried 3 things");
  expect(line.querySelector("svg.fold-line-chevron")).not.toBeNull();
  act(() => line.click());
  expect(opened).toEqual({ kind: "work", threadId: "jt", runId: "run-9" });
});

it("says how many side jobs are still going and opens them", () => {
  act(() => root.render(createElement("div", null, createElement(SideJobsStillGoing, { threadId: "jt", count: 2 }), createElement(PanelProbe))));
  const line = host.querySelector<HTMLButtonElement>("button[data-side-jobs-going]")!;
  expect(line.textContent).toBe("2 side jobs still going");
  act(() => line.click());
  expect(opened).toEqual({ kind: "side-jobs", threadId: "jt" });
});

it("sits 4 above the answer it folds, taking back the transcript's 12 gap", () => {
  act(() => root.render(createElement(FoldLine, { threadId: "jt", runId: "run-9", sentence: "Made a change" })));
  expect(host.querySelector("button[data-fold-line]")!.className.split(" ")).toContain("-mb-2");
});
