// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopWorkspaceSwitcher } from "./DesktopWorkspaceSwitcher";

let root: Root;
let host: HTMLDivElement;
const state = vi.fn(async () => ({ local: true, name: "This computer" }));
const menu = vi.fn(async () => undefined);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.mockClear();
  menu.mockReset();
  vi.stubGlobal("window", Object.assign(window, { laterdog: { workspaces: { state, menu } } }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  delete window.laterdog;
  vi.unstubAllGlobals();
});

it("keeps saved workspaces in a closed Advanced disclosure without inspecting or changing the active workspace", async () => {
  await act(async () => root.render(createElement(DesktopWorkspaceSwitcher)));
  const advanced = host.querySelector("details")!;
  expect(advanced.open).toBe(false);
  expect(advanced.querySelector("summary")?.textContent).toBe("Advanced");
  expect(host.textContent).toContain("Workspace recovery");
  expect(host.textContent).not.toContain("This computer");
  expect(host.textContent).not.toContain("My Cloud");
  expect(state).not.toHaveBeenCalled();
  expect(menu).not.toHaveBeenCalled();
  advanced.open = true;
  await act(async () => host.querySelector("button")!.click());
  expect(menu).toHaveBeenCalledExactlyOnceWith();
  expect(state).not.toHaveBeenCalled();
});

it("reports a failed recovery menu and allows a retry", async () => {
  menu.mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => root.render(createElement(DesktopWorkspaceSwitcher)));
  const button = host.querySelector("button")!;
  await act(async () => button.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not open saved workspaces. Try the Server menu.");
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(menu).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("does not offer desktop recovery outside the desktop app", async () => {
  delete window.laterdog;
  await act(async () => root.render(createElement(DesktopWorkspaceSwitcher)));
  expect(host.innerHTML).toBe("");
  expect(menu).not.toHaveBeenCalled();
});
