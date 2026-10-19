// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));

const { Sidebar } = await import("./Sidebar");
const { BotEditorStore, initialState } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");
const { setSidebarDensity } = await import("@/lib/sidebar-preferences");
const { COLLAPSE_MS } = await import("@/lib/collapse-phase");

const dog = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  ...extra,
});

const state: AppState = {
  ...initialState,
  connected: true,
  selectedId: "scout",
  sections: ["Work"],
  bots: [dog("atlas", "Atlas", { section: "Work" }), dog("scout", "Scout")],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
};
const dispatch = vi.fn();
let root: Root;
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function draw() {
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(Sidebar, { open: true, onClose: () => {} }) })));
  await wait();
}

const renameInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Rename"]');
const button = (label: string) => [...document.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find((element) =>
  element.textContent?.trim() === label || element.getAttribute("aria-label")?.startsWith(label));

async function chooseRenameFromMenu(botId: string) {
  const row = document.querySelector(`[data-sidebar-bot-row="${botId}"]`)!;
  flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
  await wait();
  const rename = button("Rename Dog");
  expect(rename).toBeDefined();
  flushSync(() => rename!.click());
  await wait();
}

async function toggleSection(name: string, expanded: boolean) {
  const toggle = document.querySelector<HTMLButtonElement>(`[data-section="${name}"] button[aria-expanded]`);
  expect(toggle?.getAttribute("aria-expanded")).toBe(String(expanded));
  flushSync(() => toggle!.click());
  await wait(COLLAPSE_MS + 60);
}

beforeAll(async () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  setLocale("en");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await draw();
});
afterEach(async () => {
  setSidebarDensity("comfortable");
  dispatch.mockClear();
  await draw();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("Rename Dog from the sidebar menu", () => {
  it("opens the rename box once, and not again when the dog's section is closed and reopened", async () => {
    await chooseRenameFromMenu("atlas");
    const input = renameInput();
    expect(input).not.toBeNull();
    flushSync(() => input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await wait();
    expect(renameInput()).toBeNull();

    await toggleSection("Work", true);
    expect(document.querySelector('[data-sidebar-bot-row="atlas"]')).toBeNull();
    await toggleSection("Work", false);
    expect(document.querySelector('[data-sidebar-bot-row="atlas"]')).not.toBeNull();
    expect(renameInput()).toBeNull();
  });

  it("opens the dog's name settings from the icon rail instead of doing nothing", async () => {
    setSidebarDensity("icons");
    await wait();
    await chooseRenameFromMenu("atlas");
    expect(renameInput()).toBeNull();
    expect(dispatch).toHaveBeenCalledWith({ type: "select", id: "atlas" });
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, section: "identity" });

    setSidebarDensity("comfortable");
    await wait();
    expect(renameInput()).toBeNull();
  });
});
