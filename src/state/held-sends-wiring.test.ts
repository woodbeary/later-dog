// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import { withDeskQueue } from "../../deploy/laterdog/home/src/desk.ts";
import type { Action, AppState, BotAnnouncement, Group } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "coordinator", title: "", description: "",
  notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "codex", model: "gpt" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
};
const room: Group = {
  id: "room", threadId: "room-thread", name: "Room", memberIds: ["bot"],
  defaultResponder: { kind: "member", botId: "bot" }, bulletin: "", unread: false, createdAt: 1, messages: [],
};
const peripherals: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
  "/api/helpers": { helpers: {} },
};

const { StoreProvider, useStore } = await import("./store");
const { HELD_NOT_SENT, HELD_SENDS_KEY } = await import("@/lib/held-sends");
const { failedComposerSends } = await import("@/lib/drafts");
const { NO_LONGER_WAITING_MESSAGE } = await import("@/lib/plain-client-error");

const HELD_ID = "wiring-held-send-0001";
const WORDS = "wake up and ship it";
const DRAFT = "bot:bot:thread";
const waitingAtEdge = { id: HELD_ID, path: "/api/bots/bot/messages", headers: {}, body: JSON.stringify({ text: WORDS, sendId: HELD_ID, threadId: "thread" }), at: 1, threadId: "thread" };
const savedChats = { bots: [{ ...bot, messages: [] }], groups: [room], botQueuedMessages: {} };

let seen!: AppState;
let dispatch!: Dispatch<Action>;
function Probe() {
  const store = useStore();
  seen = store.state;
  dispatch = store.dispatch;
  return null;
}
let root: Root | null = null;
let cursor = 0;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const frame = async (value: object) => {
  FixtureEventSource.opened.at(-1)!.send(value, `run:${++cursor}`);
  await settle();
};
const reconnect = () => frame({ kind: "hello", resumed: false, cursor: `run:${cursor}` });
const keptOnDevice = () => (JSON.parse(localStorage.getItem(HELD_SENDS_KEY) ?? "[]") as Array<{ sendId: string }>).map((held) => held.sendId);

interface Home {
  chats: unknown;
  held: unknown;
  answer?: (path: string, init?: RequestInit) => Response | undefined;
}

async function mount(home: Home) {
  FixtureEventSource.opened = [];
  vi.stubGlobal("EventSource", FixtureEventSource);
  const requests = vi.fn(async (path: string, init?: RequestInit) => {
    const own = home.answer?.(path, init);
    if (own) return own;
    if (path.startsWith("/api/bots?")) return new Response(JSON.stringify(home.chats));
    if (path.startsWith("/api/held-sends")) return new Response(JSON.stringify(home.held));
    return new Response(JSON.stringify(peripherals[path] ?? {}));
  });
  vi.stubGlobal("fetch", requests);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  await reconnect();
  const asks = () => requests.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/api/held-sends"));
  return { requests, asks };
}

const keepOnDevice = (sendId = HELD_ID) => localStorage.setItem(HELD_SENDS_KEY, JSON.stringify([{ sendId, threadId: "thread", draftId: DRAFT, text: WORDS, requestText: WORDS, at: Date.now() }]));

afterEach(() => {
  root?.unmount();
  root = null;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("held messages through the app's own store", () => {
  it("after a restart, keeps the copy and the queued row while the edge answers the refresh, then shows Not sent with the words when the edge drops it", async () => {
    keepOnDevice();
    const before = failedComposerSends(DRAFT).length;
    const home: Home = { chats: withDeskQueue(savedChats, [waitingAtEdge]), held: { held: [HELD_ID], dropped: [] } };
    const { asks } = await mount(home);
    expect(seen.pendingQueued.thread).toEqual([{ queueId: HELD_ID, text: WORDS, sendId: HELD_ID }]);
    expect(asks().length).toBeGreaterThan(0);
    expect(new Set(asks())).toEqual(new Set([`/api/held-sends?ids=${HELD_ID}`]));
    expect(keptOnDevice()).toEqual([HELD_ID]);
    expect(seen.paneErrors["chat:thread"]).toBeUndefined();

    home.chats = savedChats;
    home.held = { held: [], dropped: [{ id: HELD_ID, why: "refused", at: 9 }] };
    await reconnect();
    expect(keptOnDevice()).toEqual([]);
    expect(seen.pendingQueued.thread).toBeUndefined();
    expect(seen.paneErrors["chat:thread"]?.line).toBe(HELD_NOT_SENT);
    expect(failedComposerSends(DRAFT).slice(before)).toEqual([expect.objectContaining({ sendId: HELD_ID, text: WORDS, threadId: "thread" })]);
  });

  it("lets go of the copy without a word once a refresh from the home shows the message in the chat", async () => {
    keepOnDevice();
    const before = failedComposerSends(DRAFT).length;
    const landed = { id: "home-line-1", role: "user", kind: "text", text: WORDS, at: 5, sendId: HELD_ID };
    const { asks } = await mount({ chats: { ...savedChats, bots: [{ ...bot, messages: [landed], activeLeafId: "home-line-1" }] }, held: { held: [], dropped: [{ id: HELD_ID, why: "expired", at: 9 }] } });
    expect(keptOnDevice()).toEqual([]);
    expect(asks()).toEqual([]);
    expect(seen.paneErrors["chat:thread"]).toBeUndefined();
    expect(failedComposerSends(DRAFT).length).toBe(before);
    expect(seen.bots[0]!.messages.filter((message) => message.sendId === HELD_ID)).toHaveLength(1);
  });

  it("forgets the copy when cancel is answered, and says a message that is gone in a sentence", async () => {
    keepOnDevice();
    const before = failedComposerSends(DRAFT).length;
    const home: Home = {
      chats: withDeskQueue(savedChats, [waitingAtEdge]),
      held: { held: [HELD_ID], dropped: [] },
      answer: (path, init) => {
        if (path === `/api/bots/bot/queue/${HELD_ID}` && init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }));
        if (path.endsWith("/steer")) return new Response(JSON.stringify({ error: "no such queued message" }), { status: 404 });
        return undefined;
      },
    };
    await mount(home);
    expect(keptOnDevice()).toEqual([HELD_ID]);

    flushSync(() => dispatch({ type: "steerQueued", botId: "bot", threadId: "thread", queueId: "gone-queue-id" }));
    await settle();
    expect(seen.paneErrors["chat:thread"]?.line).toBe(NO_LONGER_WAITING_MESSAGE);

    const onCancelled = vi.fn();
    flushSync(() => dispatch({ type: "cancelQueued", botId: "bot", threadId: "thread", queueId: HELD_ID, onCancelled }));
    await settle();
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(seen.pendingQueued.thread).toBeUndefined();
    expect(keptOnDevice()).toEqual([]);

    home.chats = savedChats;
    home.held = { held: [], dropped: [{ id: HELD_ID, why: "expired", at: 9 }] };
    await reconnect();
    expect(failedComposerSends(DRAFT).length).toBe(before);
  });

  it("shows one message when the same send is sent again while the edge holds it and again after the home took it", async () => {
    const before = failedComposerSends(DRAFT).length;
    const homeLine = { id: "home-line-1", role: "user", kind: "text", text: WORDS, at: 5, sendId: HELD_ID, queueId: "home-queue-1" };
    let homeHasIt = false;
    const home: Home = {
      chats: savedChats,
      held: { held: [HELD_ID], dropped: [] },
      answer: (path, init) => {
        if (path !== "/api/bots/bot/messages" || init?.method !== "POST") return undefined;
        return homeHasIt
          ? new Response(JSON.stringify({ ok: true, threadId: "thread", message: homeLine }), { status: 202 })
          : new Response(JSON.stringify({ ok: true, queued: true, queueId: HELD_ID, threadId: "thread" }), { status: 202 });
      },
    };
    const { requests } = await mount(home);
    const sendIt = async () => {
      flushSync(() => dispatch({ type: "send", botId: "bot", threadId: "thread", text: WORDS, sendId: HELD_ID, recovery: { draftId: DRAFT, text: WORDS } }));
      await settle();
    };
    const posted = () => requests.mock.calls.filter(([path, init]) => path === "/api/bots/bot/messages" && init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)).sendId);
    const shown = () => seen.bots[0]!.messages.filter((message) => message.sendId === HELD_ID);

    await sendIt();
    await sendIt();
    expect(posted()).toEqual([HELD_ID, HELD_ID]);
    expect(seen.pendingQueued.thread).toEqual([{ queueId: HELD_ID, text: WORDS }]);
    expect(shown()).toEqual([]);
    expect(keptOnDevice()).toEqual([HELD_ID]);

    homeHasIt = true;
    await frame({ kind: "message", threadId: "thread", message: homeLine } as ServerFrame);
    expect(seen.pendingQueued.thread).toBeUndefined();
    expect(shown().map((message) => message.id)).toEqual(["home-line-1"]);

    await sendIt();
    expect(posted()).toEqual([HELD_ID, HELD_ID, HELD_ID]);
    expect(seen.pendingQueued.thread).toBeUndefined();
    expect(shown().map((message) => message.id)).toEqual(["home-line-1"]);

    home.chats = { ...savedChats, bots: [{ ...bot, messages: [homeLine], activeLeafId: "home-line-1" }] };
    home.held = { held: [], dropped: [] };
    await reconnect();
    expect(keptOnDevice()).toEqual([]);
    expect(seen.pendingQueued.thread).toBeUndefined();
    expect(shown().map((message) => message.id)).toEqual(["home-line-1"]);
    expect(seen.paneErrors["chat:thread"]).toBeUndefined();
    expect(failedComposerSends(DRAFT).length).toBe(before);
  });

  it("keeps a group message the edge holds, with no composer behind it, and clears its row when the home's line arrives", async () => {
    const roomSend = "wiring-room-send-0001";
    const home: Home = {
      chats: savedChats,
      held: { held: [roomSend], dropped: [] },
      answer: (path, init) => path === "/api/groups/room/messages" && init?.method === "POST"
        ? new Response(JSON.stringify({ ok: true, queued: true, queueId: roomSend, threadId: "room-thread" }), { status: 202 })
        : undefined,
    };
    const { requests } = await mount(home);
    flushSync(() => dispatch({ type: "sendGroup", groupId: "room", threadId: "room-thread", text: "Room, wake up", sendId: roomSend }));
    await settle();
    const posts = requests.mock.calls.filter(([path]) => path === "/api/groups/room/messages").map(([, init]) => JSON.parse(String(init?.body)));
    expect(posts).toEqual([expect.objectContaining({ sendId: roomSend, text: "Room, wake up", threadId: "room-thread" })]);
    expect(seen.pendingQueued["room-thread"]).toEqual([{ queueId: roomSend, text: "Room, wake up" }]);
    expect(keptOnDevice()).toEqual([roomSend]);

    await frame({ kind: "message", threadId: "room-thread", message: { id: "room-line-1", role: "user", kind: "text", text: "Room, wake up", at: 9, sendId: roomSend, queueId: "home-queue-3" } } as ServerFrame);
    expect(seen.pendingQueued["room-thread"]).toBeUndefined();
    expect(seen.groups[0]!.messages.filter((message) => message.sendId === roomSend)).toHaveLength(1);

    home.chats = { ...savedChats, groups: [{ ...room, messages: [{ id: "room-line-1", role: "user", kind: "text", text: "Room, wake up", at: 9, sendId: roomSend, queueId: "home-queue-3" }] }] };
    await reconnect();
    expect(keptOnDevice()).toEqual([]);
    expect(seen.paneErrors["chat:room-thread"]).toBeUndefined();
  });

  it("after a restart, shows a group message the edge still holds as queued again, and cancel takes it away for good", async () => {
    const roomSend = "wiring-room-send-0002";
    localStorage.setItem(HELD_SENDS_KEY, JSON.stringify([{ sendId: roomSend, threadId: "room-thread", draftId: "group:room:room-thread", text: "Room, wake up", requestText: "Room, wake up", at: Date.now() }]));
    const home: Home = {
      chats: savedChats,
      held: { held: [roomSend], dropped: [] },
      answer: (path, init) => path === `/api/groups/room/queue/${roomSend}` && init?.method === "DELETE" ? new Response(JSON.stringify({ ok: true })) : undefined,
    };
    const { requests } = await mount(home);
    expect(seen.pendingQueued["room-thread"]).toEqual([{ queueId: roomSend, text: "Room, wake up" }]);
    expect(keptOnDevice()).toEqual([roomSend]);

    await reconnect();
    expect(seen.pendingQueued["room-thread"]).toEqual([{ queueId: roomSend, text: "Room, wake up" }]);

    flushSync(() => dispatch({ type: "cancelGroupQueued", groupId: "room", threadId: "room-thread", queueId: roomSend }));
    await settle();
    expect(requests.mock.calls.filter(([path]) => path === `/api/groups/room/queue/${roomSend}`)).toHaveLength(1);
    expect(seen.pendingQueued["room-thread"]).toBeUndefined();
    expect(keptOnDevice()).toEqual([]);

    home.held = { held: [], dropped: [] };
    await reconnect();
    expect(seen.pendingQueued["room-thread"]).toBeUndefined();
    expect(seen.paneErrors["chat:room-thread"]).toBeUndefined();
  });
});
