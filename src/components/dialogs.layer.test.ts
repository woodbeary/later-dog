// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: vi.fn() }) };
});

const { AboutDialog } = await import("./AboutDialog");
const { CommandAllowlistDialog } = await import("./CommandAllowlistDialog");
const { FullAccessWarning } = await import("./FullAccessWarning");
const { LocalComputerAutoWarning } = await import("./LocalComputerAutoWarning");

const dialogs: Array<[string, () => ReactElement]> = [
  ["About", () => createElement(AboutDialog, { open: true, onClose: () => {} })],
  ["the full access warning", () => createElement(FullAccessWarning, { open: true, onCancel: () => {}, onConfirm: () => {} })],
  ["the computer warning", () => createElement(LocalComputerAutoWarning, { open: true, onCancel: () => {}, onConfirm: () => {} })],
  ["the allowed commands list", () => createElement(CommandAllowlistDialog, { botId: "pepper", botName: "Pepper", onClose: () => {} })],
];

let bar: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  bar = document.createElement("div");
  bar.style.cssText = "position: absolute; z-index: 10; isolation: isolate";
  document.body.append(bar);
  root = createRoot(bar);
});
afterEach(async () => {
  await act(async () => root.unmount());
  bar.remove();
  vi.unstubAllGlobals();
});

describe("a dialog opened from inside a bar", () => {
  it.each(dialogs)("puts %s over the whole window, not inside the bar", async (_name, dialog) => {
    await act(async () => root.render(dialog()));
    const shown = document.querySelector<HTMLElement>("[role='dialog'], [role='alertdialog']")!;
    expect(shown).not.toBeNull();
    expect(bar.contains(shown)).toBe(false);
    const overlay = shown.closest<HTMLElement>(".fixed")!;
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.className).toMatch(/\binset-0\b/);
  });
});
