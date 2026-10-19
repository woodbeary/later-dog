// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, AppState, Bot, Group, InstanceInfo } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { Sidebar } = await import("./Sidebar");
const { BotEditorStore, initialState } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");
const { sidebarOrder } = await import("@/lib/sidebar-order");

const dog = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `t-${id}`, name, title: "", description: "", color: "green", notifications: true, unread: false,
  busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" }, ...extra,
});
const room = (id: string, name: string, extra: Partial<Group> = {}): Group => ({
  id, name, threadId: `t-${id}`, memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 0, messages: [], ...extra,
});

let root: Root;
const dispatch = vi.fn<(action: Action) => void>();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function draw(state: Partial<AppState>) {
  const value = {
    state: { ...initialState, connected: true, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo], ...state } as AppState,
    dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
  };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(Sidebar, { open: true, onClose: () => {} }) })));
  await settle();
}
const headers = () => [...document.querySelectorAll("[data-section]")].map((header) => header.getAttribute("data-section"));
const rows = () => [...document.querySelectorAll("[data-sidebar-bot-row],[data-sidebar-group-row]")]
  .map((row) => row.getAttribute("data-sidebar-bot-row") ?? row.getAttribute("data-sidebar-group-row"));

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  localStorage.clear();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  dispatch.mockClear();
});
afterEach(() => {
  root.unmount();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the sidebar, like Grok Bot's", () => {
  it("shows pins only as the avatar grid, with the main dog first", async () => {
    await draw({
      bots: [dog("a", "Atlas", { pinned: true }), dog("m", "Main", { pinned: true, chiefOfStaff: true }), dog("s", "Scout")],
      selectedId: "s",
    });
    const grid = document.querySelector("[data-sidebar-pinned-grid]")!;
    expect([...grid.querySelectorAll("[data-sidebar-bot-row]")].map((row) => row.getAttribute("data-sidebar-bot-row"))).toEqual(["m", "a"]);
    expect(headers()).toEqual([]);
    expect(document.body.textContent).not.toContain("Pinned");
    expect(sidebarOrder()).toEqual(["m", "a", "s"]);
  });

  it("lists sections in the server's order with counts, then Unassigned with group chats and dogs, and Drag dogs here for an empty one", async () => {
    await draw({
      sections: ["Work", "Home", "Empty"],
      bots: [dog("w", "Writer", { section: "Work" }), dog("h", "Helper", { section: "Home" }), dog("u", "Loose")],
      groups: [room("g", "Launch"), room("gw", "Standup", { section: "Work" })],
    });
    expect(headers()).toEqual(["Work", "Home", "Empty", "Unassigned"]);
    const counts = [...document.querySelectorAll("[data-section]")].map((header) => header.querySelector("[data-section-count]")?.textContent);
    expect(counts).toEqual(["2", "1", "0", "2"]);
    expect(rows()).toEqual(["gw", "w", "h", "g", "u"]);
    expect(document.querySelectorAll("[data-section-empty]")).toHaveLength(1);
    expect(document.querySelector("[data-section-empty]")?.textContent).toBe("Drag dogs here");
    expect(sidebarOrder()).toEqual(["gw", "w", "h", "g", "u"]);
  });

  it("keeps hidden dogs in a collapsed Hidden dogs group at the bottom, out of the order shortcuts walk", async () => {
    await draw({ bots: [dog("a", "Atlas"), dog("h", "Willow", { hidden: true, section: "Work" })], sections: ["Work"] });
    const toggle = document.querySelector<HTMLButtonElement>("[data-sidebar-hidden-dogs]")!;
    expect(toggle.textContent).toBe("Hidden dogs1");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rows()).toEqual(["a"]);
    expect(headers()).toEqual(["Work", "Unassigned"]);
    expect(sidebarOrder()).toEqual(["a"]);
    flushSync(() => toggle.click());
    await settle();
    expect(rows()).toEqual(["a", "h"]);
    expect(sidebarOrder()).toEqual(["a"]);
  });

  it("puts Search and New at the top and the avatar, Connect apps and update in the footer", async () => {
    await draw({ bots: [dog("a", "Atlas")] });
    const top = document.querySelector("[data-sidebar-top-buttons]")!;
    expect([...top.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Search", "New"]);
    flushSync(() => (top.querySelector('button[aria-label="Search"]') as HTMLButtonElement).click());
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleSearch", open: true });
    expect(document.querySelector('input[aria-label="Search dogs and messages"]')).toBeNull();
    const footer = document.querySelector("[data-sidebar-footer]")!;
    expect(footer.querySelector("[data-sidebar-profile]")).not.toBeNull();
    expect(footer.querySelector('[data-sidebar-nav="connect-apps"]')?.textContent).toBe("Connect apps");
  });

  it("toggles a group chat between Mark as Unread and Mark as Read", async () => {
    await draw({ groups: [room("g", "Launch", { unread: true })], bots: [dog("a", "Atlas")] });
    const row = document.querySelector<HTMLElement>('[data-sidebar-group-row="g"]')!;
    expect(row.hasAttribute("data-sidebar-unread")).toBe(true);
    flushSync(() => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })));
    await settle();
    const read = [...document.querySelectorAll<HTMLButtonElement>("[data-room-menu] button")].find((button) => button.textContent === "Mark as Read")!;
    expect(read).toBeDefined();
    flushSync(() => read.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "patchGroup", groupId: "g", patch: { unread: false } });
  });
});
