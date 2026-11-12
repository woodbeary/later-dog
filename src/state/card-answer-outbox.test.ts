// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Action, AppState, BotAnnouncement } from "./store";

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
const question = {
  id: "card-1", role: "bot", kind: "options", at: 1,
  card: { title: "Which colour?", subtitle: "", options: ["Red", "Blue"] },
};
const peripherals: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
  "/api/helpers": { helpers: {} },
};

const { StoreProvider, useStore } = await import("./store");
const { failedComposerSends } = await import("@/lib/drafts");
const { HELD_SENDS_KEY } = await import("@/lib/held-sends");

const DRAFT = "bot:bot:thread";
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
const reconnect = async () => {
  FixtureEventSource.opened.at(-1)!.send({ kind: "hello", resumed: false, cursor: `run:${cursor}` }, `run:${++cursor}`);
  await settle();
};

interface Home {
  chats: unknown;
  held: unknown;
  receipt: () => Response | Promise<Response>;
}

async function mount(home: Home) {
  FixtureEventSource.opened = [];
  vi.stubGlobal("EventSource", FixtureEventSource);
  const requests = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/bots/bot/messages" && init?.method === "POST") return home.receipt();
    if (path.startsWith("/api/bots?")) return new Response(JSON.stringify(home.chats));
    if (path.startsWith("/api/held-sends")) return new Response(JSON.stringify(home.held));
    if (path.startsWith("/api/bots/bot/cards/")) return new Response("{}");
    return new Response(JSON.stringify(peripherals[path] ?? {}));
  });
  vi.stubGlobal("fetch", requests);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  await reconnect();
  const posts = () => requests.mock.calls
    .filter(([path, init]) => path === "/api/bots/bot/messages" && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)) as { text: string; sendId?: string; threadId?: string });
  const saved = () => requests.mock.calls.filter(([path]) => String(path).startsWith("/api/bots/bot/cards/card-1")).map(([, init]) => JSON.parse(String(init?.body)));
  return { requests, posts, saved };
}

const card = () => seen.bots[0]!.messages.find((message) => message.id === "card-1")!.card!;
const chats = (messages: unknown[]) => ({ bots: [{ ...bot, messages, activeLeafId: null }], groups: [], botQueuedMessages: {} });
const answerRed = async () => {
  flushSync(() => dispatch({ type: "answerCard", botId: "bot", threadId: "thread", messageId: "card-1", answer: "Red" }));
  await settle();
};

afterEach(() => {
  root?.unmount();
  root = null;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("answering a card goes through the device outbox", () => {
  it("sends the answer with a send id, shows the card as waiting, and marks it answered only when the home's receipt arrives", async () => {
    let receipt!: (response: Response) => void;
    const home: Home = { chats: chats([question]), held: { held: [], dropped: [] }, receipt: () => new Promise<Response>((resolve) => { receipt = resolve; }) };
    const { posts, saved } = await mount(home);
    await answerRed();
    expect(posts()).toEqual([expect.objectContaining({ text: "Red", threadId: "thread", sendId: expect.stringMatching(/^[\w-]{16,80}$/) })]);
    expect(card().answered).toBeUndefined();
    expect(card().pendingAnswer).toBe("Red");
    expect(saved()).toEqual([]);

    receipt(new Response(JSON.stringify({ ok: true, threadId: "thread", message: { id: "home-line-1", role: "user", kind: "text", text: "Red", at: 5, sendId: posts()[0]!.sendId } }), { status: 202 }));
    await settle();
    expect(card()).toMatchObject({ answered: "Red", dismissed: true });
    expect(card().pendingAnswer).toBeUndefined();
    expect(saved()).toEqual([{ answered: "Red", dismissed: true }]);
  });

  it("keeps the card waiting while the edge holds the answer, shows it queued like a typed message, and marks it answered once the home has it", async () => {
    let sendId = "";
    const home: Home = {
      chats: chats([question]),
      held: { held: [], dropped: [] },
      receipt: () => new Response(JSON.stringify({ ok: true, queued: true, queueId: sendId, threadId: "thread" }), { status: 202 }),
    };
    const { posts, saved } = await mount(home);
    flushSync(() => dispatch({ type: "answerCard", botId: "bot", threadId: "thread", messageId: "card-1", answer: "Blue", sendId: (sendId = "card-answer-send-0001") }));
    await settle();
    expect(posts()).toEqual([expect.objectContaining({ text: "Blue", sendId })]);
    expect(seen.pendingQueued.thread).toEqual([{ queueId: sendId, text: "Blue" }]);
    expect(JSON.parse(localStorage.getItem(HELD_SENDS_KEY) ?? "[]")).toEqual([expect.objectContaining({ sendId, text: "Blue" })]);
    expect(card().answered).toBeUndefined();
    expect(card().pendingAnswer).toBe("Blue");
    expect(saved()).toEqual([]);

    home.held = { held: [sendId], dropped: [] };
    await reconnect();
    expect(card().answered).toBeUndefined();

    const homeLine = { id: "home-line-1", role: "user", kind: "text", text: "Blue", at: 5, sendId };
    home.chats = chats([question, homeLine]);
    home.held = { held: [], dropped: [] };
    await reconnect();
    expect(card()).toMatchObject({ answered: "Blue", dismissed: true });
    expect(card().pendingAnswer).toBeUndefined();
    expect(saved()).toEqual([{ answered: "Blue", dismissed: true }]);
  });

  it("makes the card answerable again and shows Not sent with the answer when the edge drops the held answer", async () => {
    const before = failedComposerSends(DRAFT).length;
    let sendId = "";
    const home: Home = {
      chats: chats([question]),
      held: { held: [], dropped: [] },
      receipt: () => new Response(JSON.stringify({ ok: true, queued: true, queueId: sendId, threadId: "thread" }), { status: 202 }),
    };
    const { saved } = await mount(home);
    flushSync(() => dispatch({ type: "answerCard", botId: "bot", threadId: "thread", messageId: "card-1", answer: "Blue", sendId: (sendId = "card-answer-send-0002") }));
    await settle();
    home.held = { held: [], dropped: [{ id: sendId, why: "refused", at: 9 }] };
    await reconnect();
    expect(card().answered).toBeUndefined();
    expect(card().pendingAnswer).toBeUndefined();
    expect(seen.pendingQueued.thread).toBeUndefined();
    expect(failedComposerSends(DRAFT).slice(before)).toEqual([expect.objectContaining({ sendId, text: "Blue", threadId: "thread" })]);
    expect(saved()).toEqual([]);
  });

  it("makes the card answerable again and shows Not sent with the answer when the home refuses it", async () => {
    const before = failedComposerSends(DRAFT).length;
    const home: Home = { chats: chats([question]), held: { held: [], dropped: [] }, receipt: () => new Response(JSON.stringify({ error: "That dog is not here." }), { status: 404 }) };
    const { posts, saved } = await mount(home);
    await answerRed();
    expect(posts()).toHaveLength(1);
    expect(card().answered).toBeUndefined();
    expect(card().pendingAnswer).toBeUndefined();
    expect(failedComposerSends(DRAFT).slice(before)).toEqual([expect.objectContaining({ sendId: posts()[0]!.sendId, text: "Red", requestText: "Red", threadId: "thread" })]);
    expect(seen.paneErrors["chat:thread"]).toBeDefined();
    expect(saved()).toEqual([]);
  });
});
