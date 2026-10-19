// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, AppState, Bot, Group } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { host: { packaged: true, platform: "other" } }, ready: true }),
}));

const { CommandPalette, matchingApps, matchingCommands, searchDogs } = await import("./CommandPalette");
const { BotEditorStore, initialState } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");

const dog = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `t-${id}`, name, title: "", description: "", color: "green", notifications: true, unread: false,
  messages: [], modelSelection: { instanceId: "test", model: "m" }, ...extra,
});
const group: Group = { id: "g1", name: "Desk planning", threadId: "t-g1", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 0, messages: [] };

let root: Root;
const dispatch = vi.fn<(action: Action) => void>();
function draw(state: Partial<AppState>) {
  const value = { state: { ...initialState, searchOpen: true, ...state } as AppState, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(CommandPalette) })));
}
function type(text: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Search dogs and messages"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
}
const options = () => [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("fetch", () => new Promise(() => {}));
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

describe("search, like Grok Bot's", () => {
  it("lists hidden dogs only for a typed search, after the visible ones, tagged Hidden", () => {
    const bots = [dog("a", "Desk Notes", { hidden: true }), dog("b", "Desktop Helper"), dog("c", "Pepper")];
    expect(searchDogs(bots, "").map((bot) => bot.id)).toEqual(["b", "c"]);
    expect(searchDogs(bots, "desk").map((bot) => bot.id)).toEqual(["b", "a"]);
  });

  it("finds apps and commands by what you type", () => {
    expect(matchingApps("linear").map((app) => app.id)).toContain("linear");
    expect(matchingApps("")).toEqual([]);
    expect(matchingCommands("settings").map((command) => command.id)).toEqual(["settings"]);
    expect(matchingCommands("connect").map((command) => command.id)).toEqual(["connect-apps"]);
    expect(matchingCommands("")).toEqual([]);
  });

  it("shows a hidden dog tagged Hidden and opens it without showing it in the sidebar again", () => {
    draw({ bots: [dog("a", "Desk Notes", { hidden: true }), dog("b", "Pepper")], groups: [group] });
    expect(options()).toEqual(["Pepper", "Desk planning"]);
    type("desk");
    expect(options()[0]).toBe("Desk NotesHidden");
    expect(options()).toContain("Desk planning");
    flushSync(() => (document.querySelector('[role="option"]') as HTMLButtonElement).click());
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleSearch", open: false });
    expect(dispatch).toHaveBeenCalledWith({ type: "select", id: "a" });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateBot" }));
  });

  it("runs a command row with its shortcut shown", () => {
    draw({ bots: [dog("b", "Pepper")] });
    type("new dog");
    const row = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent?.startsWith("New dog"))!;
    expect(row.querySelector("kbd")).not.toBeNull();
    flushSync(() => row.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleNewBot", open: true });
  });

  it("closes on Escape", () => {
    draw({ bots: [dog("b", "Pepper")] });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search dogs and messages"]')!;
    flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleSearch", open: false });
  });
});
