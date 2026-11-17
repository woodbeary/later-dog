// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeWorkPanel, openWorkPanel } from "@/lib/work-panel";
import { WorkPanel } from "./WorkPanel";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.reducedMotion = "true";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => { closeWorkPanel(); root.unmount(); }); host.remove(); });

const panel = () => host.querySelector("[data-work-panel]");

it("renders nothing when closed and the whole column when open", async () => {
  await act(async () => root.render(createElement(WorkPanel, { botId: "b1", botName: "Juniper" })));
  expect(host.innerHTML).toBe("");
  await act(async () => openWorkPanel({ kind: "work", threadId: "t1" }));
  expect(panel()).not.toBeNull();
  expect(panel()!.tagName).toBe("ASIDE");
  expect(panel()!.getAttribute("role")).not.toBe("dialog");
});

it("closes on Esc and never takes focus from the composer", async () => {
  const composer = document.createElement("textarea"); document.body.append(composer); composer.focus();
  await act(async () => root.render(createElement(WorkPanel, { botId: "b1", botName: "Juniper" })));
  await act(async () => openWorkPanel({ kind: "work", threadId: "t1" }));
  expect(document.activeElement).toBe(composer);
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(panel()).toBeNull();
  expect(document.activeElement).toBe(composer);
  composer.remove();
});
