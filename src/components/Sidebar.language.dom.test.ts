// @vitest-environment happy-dom
import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group, InstanceInfo } from "@/state/store";
import type { StoreChannel } from "@/state/store-channel";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));

const { Sidebar } = await import("./Sidebar");
const { initialState } = await import("@/state/store");
const { StoreChannelContext, createStoreFeed } = await import("@/state/store-channel");
const { setLocale } = await import("@/lib/i18n");

const NOW = new Date(2026, 9, 4, 12, 0).getTime();
const dog = (id: string, name: string, patch: Partial<Bot> = {}): Bot => ({
  id, threadId: `thread-${id}`, name, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  ...patch,
});
const team: Group = {
  id: "team", threadId: "thread-team", name: "Team", memberIds: ["atlas", "scout"], defaultResponder: "atlas",
  bulletin: "", unread: false, createdAt: NOW, working: true, messages: [],
};

const home: AppState = {
  ...initialState,
  connected: true,
  selectedId: "atlas",
  bots: [dog("atlas", "Atlas"), dog("scout", "Scout", { busy: true, activity: "working" })],
  groups: [team],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
};

let root: Root;
let redrawShell: () => void = () => {};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const dogRow = (id: string) => document.querySelector(`[data-sidebar-bot-row="${id}"]`)!;
const roomRow = (id: string) => document.querySelector(`[data-sidebar-group-row="${id}"]`)!;

async function changeLanguage(language: string): Promise<void> {
  flushSync(() => {
    setLocale(language);
    redrawShell();
  });
  await settle();
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  setLocale("en");
  const feed = createStoreFeed(home);
  const channel: StoreChannel = { read: feed.read, listen: feed.listen, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const closeDrawer = () => {};
  function Shell() {
    const [, setLocaleEpoch] = useState(0);
    redrawShell = () => setLocaleEpoch((epoch) => epoch + 1);
    return createElement(StoreChannelContext.Provider, { value: channel }, createElement(Sidebar, { open: true, onClose: closeDrawer }));
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(Shell)));
  await settle();
});

afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setLocale("en");
});

describe("the sidebar rows after the language changes with no store change", () => {
  it("starts in English", () => {
    expect(dogRow("scout").getAttribute("aria-label")).toBe("Scout · Working");
    expect(dogRow("scout").textContent).toContain("Working…");
    expect(roomRow("team").textContent).toContain("The dogs are working…");
  });

  it("puts a dog row into Spanish when the shell redraws", async () => {
    await changeLanguage("es");
    expect(dogRow("scout").getAttribute("aria-label")).toBe("Scout · Trabajando");
    expect(dogRow("scout").textContent).toContain("Trabajando…");
  });

  it("puts a room row into Spanish on that same redraw", () => {
    expect(roomRow("team").textContent).toContain("Los perros están trabajando…");
  });

  it("puts both rows back into English", async () => {
    await changeLanguage("en");
    expect(dogRow("scout").getAttribute("aria-label")).toBe("Scout · Working");
    expect(roomRow("team").textContent).toContain("The dogs are working…");
  });
});
