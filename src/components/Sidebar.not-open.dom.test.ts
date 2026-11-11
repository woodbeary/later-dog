// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";
import type { StoreChannel, StoreFeed } from "@/state/store-channel";

const drawn = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock("./RenameTitle", () => ({
  RenameTitle: ({ value }: { value: string }) => {
    drawn.names.push(value);
    return createElement("span", null, value);
  },
}));
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
const said = (id: string, text: string): Message => ({ id, role: "bot", kind: "text", text, at: NOW });
const dog = (id: string, name: string, patch: Partial<Bot> = {}): Bot => ({
  id, threadId: `thread-${id}`, name, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
  ...patch,
});

const home: AppState = {
  ...initialState,
  connected: true,
  selectedId: "atlas",
  bots: [dog("atlas", "Atlas", { messages: [said("a1", "Done with the report.")] }), dog("scout", "Scout"), dog("pepper", "Pepper")],
  instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
};

let root: Root;
let feed: StoreFeed;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const row = (id: string) => document.querySelector(`[data-sidebar-bot-row="${id}"]`)!;
const withDog = (state: AppState, id: string, patch: Partial<Bot>): AppState => ({ ...state, bots: state.bots.map((bot) => (bot.id === id ? { ...bot, ...patch } : bot)) });

async function move(change: (state: AppState) => AppState): Promise<string[]> {
  drawn.names = [];
  flushSync(() => {
    feed.publish(change(feed.read()));
    feed.announce();
  });
  await settle();
  return [...drawn.names];
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  setLocale("en");
  feed = createStoreFeed(home);
  const channel: StoreChannel = { read: feed.read, listen: feed.listen, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreChannelContext.Provider, { value: channel }, createElement(Sidebar, { open: true, onClose: () => {} }))));
  await settle();
});

afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setLocale("en");
});

describe("the sidebar row of a dog that is not open", () => {
  it("starts with no working dots and no unread dot", () => {
    expect(row("scout").getAttribute("aria-label")).toBe("Scout");
    expect(row("scout").querySelector('[role="status"]')).toBeNull();
    expect(row("scout").querySelector('[data-status="unread"]')).toBeNull();
  });

  it("shows the working dots and says Working when that dog starts a turn, and draws no other row for it", async () => {
    expect(await move((state) => withDog(state, "scout", { busy: true, activity: "working" }))).toEqual(["Scout"]);
    expect(row("scout").getAttribute("aria-label")).toBe("Scout · Working");
    expect(row("scout").querySelectorAll('[role="status"] .animate-status-pulse')).toHaveLength(3);
  });

  it("stays working while its reply streams", async () => {
    await move((state) => withDog(state, "scout", { messages: [said("s1", "Looking")] }));
    await move((state) => withDog(state, "scout", { messages: [said("s1", "Looking at the notes now.")] }));
    expect(row("scout").getAttribute("aria-label")).toBe("Scout · Working");
    expect(row("atlas").getAttribute("aria-current")).toBe("page");
  });

  it("shows the unread dot, says Unread and previews the reply when the turn ends", async () => {
    expect(await move((state) => withDog(state, "scout", { busy: false, activity: undefined, unread: true }))).toEqual(["Scout"]);
    expect(row("scout").getAttribute("aria-label")).toBe("Scout · Unread");
    expect(row("scout").hasAttribute("data-sidebar-unread")).toBe(true);
    expect(row("scout").querySelectorAll('[data-status="unread"]')).toHaveLength(1);
    expect(row("scout").querySelector('[role="status"]')).toBeNull();
    expect(row("scout").textContent).toContain("Looking at the notes now.");
    expect(row("pepper").hasAttribute("data-sidebar-unread")).toBe(false);
  });

  it("clears the unread dot once the chat is opened and read", async () => {
    await move((state) => ({ ...withDog(state, "scout", { unread: false }), selectedId: "scout" }));
    expect(row("scout").getAttribute("aria-label")).toBe("Scout");
    expect(row("scout").getAttribute("aria-current")).toBe("page");
    expect(row("atlas").getAttribute("aria-current")).toBeNull();
    expect(row("scout").querySelector('[data-status="unread"]')).toBeNull();
  });
});
