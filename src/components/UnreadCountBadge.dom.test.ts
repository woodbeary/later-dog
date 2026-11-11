// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type AppState, type Bot, type Message } from "@/state/store";
import { StoreChannelContext, createStoreFeed, type StoreChannel, type StoreFeed } from "@/state/store-channel";
import { UnreadCountBadge } from "./UnreadCountBadge";

const dog = (id: string, patch: Partial<Bot> = {}): Bot => ({
  id,
  threadId: `thread-${id}`,
  name: id,
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...patch,
});

const said = (id: string, text: string): Message => ({ id, role: "bot", kind: "text", at: 1, text });

const withDog = (state: AppState, id: string, patch: Partial<Bot>): AppState => ({
  ...state,
  bots: state.bots.map((bot) => (bot.id === id ? { ...bot, ...patch } : bot)),
});

let host: HTMLDivElement;
let root: Root;
let feed: StoreFeed;
const setUnreadCount = vi.fn();
const desktop = window as unknown as { laterdog?: { setUnreadCount(count: number): void } };

function move(next: AppState) {
  act(() => {
    feed.publish(next);
    feed.announce();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  desktop.laterdog = { setUnreadCount };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  feed = createStoreFeed({ ...initialState, bots: [dog("pepper"), dog("scout"), dog("biscuit")], selectedId: "pepper" });
  const channel: StoreChannel = {
    read: feed.read,
    listen: feed.listen,
    dispatch: () => {},
    flushBotPatches: async () => null,
    refreshInstances: async () => {},
    refreshModels: async () => {},
  };
  act(() => root.render(createElement(StoreChannelContext.Provider, { value: channel }, createElement(UnreadCountBadge))));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete desktop.laterdog;
  setUnreadCount.mockReset();
});

describe("the unread count the app icon shows", () => {
  it("starts at the number of unread chats", () => {
    expect(setUnreadCount.mock.calls).toEqual([[0]]);
  });

  it("goes up when a dog that is not open finishes a reply, and is not sent again for each streamed piece", () => {
    move(withDog(feed.read(), "scout", { busy: true, activity: "working" }));
    move(withDog(feed.read(), "scout", { messages: [said("m1", "Work")] }));
    move(withDog(feed.read(), "scout", { messages: [said("m1", "Working on it")] }));
    expect(setUnreadCount.mock.calls).toEqual([[0]]);
    move(withDog(feed.read(), "scout", { busy: false, activity: undefined, unread: true }));
    expect(setUnreadCount.mock.calls).toEqual([[0], [1]]);
    move(withDog(feed.read(), "biscuit", { unread: true }));
    expect(setUnreadCount).toHaveBeenLastCalledWith(2);
  });

  it("goes back down when the unread chat is opened and read", () => {
    move(withDog(feed.read(), "scout", { unread: true }));
    move({ ...withDog(feed.read(), "scout", { unread: false }), selectedId: "scout" });
    expect(setUnreadCount.mock.calls).toEqual([[0], [1], [0]]);
  });
});
