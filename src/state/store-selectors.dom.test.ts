// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, type AppState, type Bot, type Message } from "@/state/store";
import { StoreChannelContext, createStoreFeed, type StoreChannel, type StoreFeed } from "@/state/store-channel";
import {
  dogIn,
  sameFields,
  sameItems,
  useDogsApartFromMessages,
  useDrawnDogs,
  useStoreDispatch,
  useStoreReader,
  useStoreSelector,
} from "@/state/store-selectors";

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

const withDog = (state: AppState, id: string, change: (bot: Bot) => Bot): AppState => ({
  ...state,
  bots: state.bots.map((bot) => (bot.id === id ? change(bot) : bot)),
});

let host: HTMLDivElement;
let root: Root;
let feed: StoreFeed;
let channel: StoreChannel;
const dispatch = vi.fn();

function shown(children: ReactNode) {
  act(() => root.render(createElement(StoreChannelContext.Provider, { value: channel }, children)));
}

function move(next: AppState) {
  act(() => {
    feed.publish(next);
    feed.announce();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  feed = createStoreFeed({ ...initialState, bots: [dog("pepper"), dog("scout")], selectedId: "pepper" });
  channel = {
    read: feed.read,
    listen: feed.listen,
    dispatch,
    flushBotPatches: async () => null,
    refreshInstances: async () => {},
    refreshModels: async () => {},
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  dispatch.mockReset();
});

describe("the store feed", () => {
  it("tells its listeners once per new state and not again for the state they already heard", () => {
    const heard = vi.fn();
    const stop = feed.listen(heard);
    feed.announce();
    expect(heard).not.toHaveBeenCalled();
    const next = { ...feed.read(), connected: true };
    feed.publish(next);
    expect(feed.read()).toBe(next);
    feed.announce();
    feed.announce();
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    feed.publish({ ...next, connected: false });
    feed.announce();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("a component that reads a slice of the store", () => {
  it("is left alone while another dog's reply streams and redraws when its own dog changes", () => {
    const drawn = vi.fn();
    function Row({ botId }: { botId: string }) {
      const bot = useStoreSelector((state) => dogIn(state, botId));
      drawn(bot?.messages.at(-1)?.text ?? "");
      return null;
    }
    shown(createElement(Row, { botId: "pepper" }));
    expect(drawn).toHaveBeenCalledTimes(1);
    move(withDog(feed.read(), "scout", (bot) => ({ ...bot, messages: [said("m1", "Work")] })));
    move(withDog(feed.read(), "scout", (bot) => ({ ...bot, messages: [said("m1", "Working on it")] })));
    expect(drawn).toHaveBeenCalledTimes(1);
    move(withDog(feed.read(), "pepper", (bot) => ({ ...bot, messages: [said("m2", "Done")] })));
    expect(drawn).toHaveBeenCalledTimes(2);
    expect(drawn).toHaveBeenLastCalledWith("Done");
  });

  it("keeps the value it had when a new pick is equal field by field", () => {
    const drawn = vi.fn();
    function Flags() {
      const view = useStoreSelector((state) => ({ selectedId: state.selectedId, connected: state.connected }), sameFields);
      drawn(view);
      return null;
    }
    shown(createElement(Flags));
    move({ ...feed.read(), searchOpen: true });
    expect(drawn).toHaveBeenCalledTimes(1);
    move({ ...feed.read(), selectedId: "scout" });
    expect(drawn).toHaveBeenCalledTimes(2);
    expect(drawn).toHaveBeenLastCalledWith({ selectedId: "scout", connected: false });
  });

  it("holds the dog list still through streamed pieces and moves it when a dog's row facts change", () => {
    const laidOut = vi.fn();
    function Layout() {
      laidOut(useDogsApartFromMessages());
      return null;
    }
    shown(createElement(Layout));
    const first = laidOut.mock.lastCall![0];
    move(withDog(feed.read(), "scout", (bot) => ({ ...bot, messages: [said("m1", "A piece")] })));
    expect(laidOut).toHaveBeenCalledTimes(1);
    move(withDog(feed.read(), "scout", (bot) => ({ ...bot, busy: true })));
    expect(laidOut).toHaveBeenCalledTimes(2);
    expect(laidOut.mock.lastCall![0]).not.toBe(first);
    expect(laidOut.mock.lastCall![0][1].busy).toBe(true);
    move({ ...feed.read(), bots: feed.read().bots.slice(0, 1) });
    expect(laidOut).toHaveBeenCalledTimes(3);
  });

  it("redraws faces when a dog is renamed and not when it gets busy", () => {
    const faces = vi.fn();
    function Faces() {
      faces(useDrawnDogs().map((bot) => bot.name).join(","));
      return null;
    }
    shown(createElement(Faces));
    move(withDog(feed.read(), "scout", (bot) => ({ ...bot, busy: true, messages: [said("m1", "A piece")] })));
    expect(faces).toHaveBeenCalledTimes(1);
    move(withDog(feed.read(), "scout", (bot) => ({ ...bot, name: "Scout the Second" })));
    expect(faces).toHaveBeenLastCalledWith("pepper,Scout the Second");
  });

  it("reads the newest state in a handler without redrawing for it, and sends actions through the channel", () => {
    const drawn = vi.fn();
    let read: () => AppState = () => initialState;
    let send: (action: { type: "toggleSearch" }) => void = () => {};
    function Handler() {
      read = useStoreReader();
      send = useStoreDispatch();
      drawn();
      return null;
    }
    shown(createElement(Handler));
    move({ ...feed.read(), selectedId: "scout" });
    expect(drawn).toHaveBeenCalledTimes(1);
    expect(read().selectedId).toBe("scout");
    send({ type: "toggleSearch" });
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleSearch" });
  });

  it("reads the whole store where no channel is offered, as a dog's settings preview does", () => {
    const seen = vi.fn();
    function Name() {
      seen(useStoreSelector((state) => dogIn(state, "scout")?.name), useStoreReader()().selectedId);
      return null;
    }
    const value = (state: AppState) => ({ state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} });
    const draft = { ...initialState, bots: [dog("scout", { name: "Draft name" })], selectedId: "scout" };
    act(() => root.render(createElement(StoreChannelContext.Provider, { value: channel }, createElement(BotEditorStore, { value: value(draft), children: createElement(Name) }))));
    expect(seen).toHaveBeenLastCalledWith("Draft name", "scout");
    act(() => root.render(createElement(StoreChannelContext.Provider, { value: channel }, createElement(BotEditorStore, { value: value(withDog(draft, "scout", (bot) => ({ ...bot, name: "Second draft" }))), children: createElement(Name) }))));
    expect(seen).toHaveBeenLastCalledWith("Second draft", "scout");
  });
});

describe("equal picks", () => {
  it("compares lists item by item and records field by field", () => {
    const pepper = dog("pepper");
    expect(sameItems([pepper], [pepper])).toBe(true);
    expect(sameItems([pepper], [{ ...pepper }])).toBe(false);
    expect(sameItems([pepper], [pepper, pepper])).toBe(false);
    expect(sameFields({ a: 1, b: pepper }, { a: 1, b: pepper })).toBe(true);
    expect(sameFields({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameFields({ a: 1 }, { a: 1, b: undefined } as { a: number })).toBe(false);
    expect(sameFields(null, null)).toBe(true);
    expect(sameFields<{ a: number } | null>({ a: 1 }, null)).toBe(false);
  });
});
