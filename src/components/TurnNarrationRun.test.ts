// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TurnNarrationRun } from "./TurnNarrationRun";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("keeps narration unmounted until expanded and connects the toggle to its details", async () => {
  await act(async () => root.render(createElement(TurnNarrationRun, {
    label: "Worked for 2m", children: createElement("p", null, "Checking the draft."),
  })));
  const toggle = host.querySelector("button")!;
  const content = document.getElementById(toggle.getAttribute("aria-controls")!)!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(content.hidden).toBe(true);
  expect(host.textContent).not.toContain("Checking the draft.");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(content.hidden).toBe(false);
  expect(content.textContent).toBe("Checking the draft.");
  await act(async () => toggle.click());
  expect(content.hidden).toBe(true);
  expect(content.childNodes).toHaveLength(0);
});

it("opens narration when search targets a hidden message", async () => {
  const draw = (forceOpen: boolean) => act(async () => root.render(createElement(TurnNarrationRun, {
    label: "Worked", forceOpen, children: createElement("p", null, "The matching update."),
  })));
  await draw(false);
  expect(host.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  await draw(true);
  expect(host.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("The matching update.");
});
