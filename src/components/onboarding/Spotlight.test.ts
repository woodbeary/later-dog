// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Avatar", () => ({ DogAvatar: () => null }));

import { Spotlight } from "./Spotlight";

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.reducedMotion = "true";
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host = null;
  document.body.innerHTML = "";
  delete document.documentElement.dataset.reducedMotion;
  vi.unstubAllGlobals();
});

const settle = () => act(async () => {
  await new Promise((done) => setTimeout(done, 40));
});

async function show(anchor: string | null, onDone = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(Spotlight, { anchor, placement: "below", onDone, primary: { label: "Next", onClick: () => {} }, children: "Type here" }),
    ),
  );
  await settle();
  return onDone;
}

function modal(extra: Record<string, string> = {}) {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  for (const [name, value] of Object.entries(extra)) dialog.setAttribute(name, value);
  dialog.append(document.createElement("button"));
  return dialog;
}

function popup(role: string) {
  const element = document.createElement("div");
  element.setAttribute("role", role);
  element.append(document.createElement("button"));
  return element;
}

function onScreen(element: HTMLElement) {
  const rect = { x: 40, y: 40, left: 40, top: 40, width: 300, height: 200, right: 340, bottom: 240, toJSON: () => ({}) };
  element.getBoundingClientRect = () => rect as DOMRect;
  element.getClientRects = () => [rect] as unknown as DOMRectList;
}

const layer = () => document.querySelector<HTMLElement>('[aria-live="polite"]');
const hidden = () => layer()!.classList.contains("invisible");
const escapeOn = (target: EventTarget) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

describe("the tour spotlight", () => {
  it("steps aside while another window is open and comes back when it closes", async () => {
    await show(null);
    expect(layer()?.textContent).toContain("Type here");
    expect(hidden()).toBe(false);
    const dialog = modal();
    document.body.append(dialog);
    await settle();
    expect(hidden()).toBe(true);
    dialog.remove();
    await settle();
    expect(hidden()).toBe(false);
  });

  it("stays hidden when it starts while a window is open", async () => {
    document.body.append(modal());
    await show(null);
    expect(hidden()).toBe(true);
  });

  it("leaves the tour alone when Escape closes another window", async () => {
    const dialog = modal();
    document.body.append(dialog);
    const onDone = await show(null);
    await escapeOn(dialog.querySelector("button")!);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("leaves the tour alone even when the window is gone before Escape reaches the page", async () => {
    const dialog = modal();
    dialog.addEventListener("keydown", () => dialog.remove());
    document.body.append(dialog);
    const onDone = await show(null);
    await escapeOn(dialog.querySelector("button")!);
    expect(dialog.isConnected).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("still ends the tour on Escape when no other window is open", async () => {
    const onDone = await show(null);
    await escapeOn(document.body);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("stays up over the window it is pointing into", async () => {
    const panel = modal({ "data-tour": "apps-panel" });
    onScreen(panel);
    document.body.append(panel);
    const onDone = await show("apps-panel");
    expect(layer()?.textContent).toContain("Type here");
    expect(hidden()).toBe(false);
    const confirm = modal();
    panel.after(confirm);
    await settle();
    expect(hidden()).toBe(true);
    confirm.remove();
    await settle();
    expect(hidden()).toBe(false);
    await escapeOn(panel);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("steps aside for an open menu or pop-up, but not for its own card", async () => {
    await show(null);
    expect(layer()?.querySelector('[role="dialog"]')).not.toBeNull();
    expect(hidden()).toBe(false);
    for (const role of ["menu", "dialog"]) {
      const open = popup(role);
      document.body.append(open);
      await settle();
      expect(hidden()).toBe(true);
      open.remove();
      await settle();
      expect(hidden()).toBe(false);
    }
  });

  it("leaves the tour alone when Escape closes a menu", async () => {
    const menu = popup("menu");
    document.body.append(menu);
    const onDone = await show(null);
    await escapeOn(menu.querySelector("button")!);
    expect(onDone).not.toHaveBeenCalled();
  });
});
