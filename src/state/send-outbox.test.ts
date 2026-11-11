import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTBOX_KEY, type OutboxItem } from "@/lib/outbox";
import { failedComposerSends } from "@/lib/drafts";
import { api, initialState, reducer, StoreProvider, useStore, type Action, type AppState, type Bot } from "./store";
import { createSendOutbox } from "./send-outbox";
import { HELD_GIVE_UP_MS, HELD_NOT_SENT, HELD_SENDS_KEY } from "@/lib/held-sends";
import { SendingTrack } from "@/components/SendingTrack";
import { withDeskQueue } from "../../deploy/laterdog/home/src/desk.ts";

function mount(request: typeof fetch) {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() {
    dispatch = useStore().dispatch;
    return null;
  }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  return { dispatch: (action: Action) => dispatch(action) };
}
afterEach(() => { initialState.bots = []; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const accepted = () => new Response(JSON.stringify({ ok: true, threadId: "thread", message: { id: "m", at: 1, role: "user", kind: "text", text: "x" } }), { status: 202 });
const waking = (seconds = 2) => new Response(JSON.stringify({ error: "waking", retryAfter: seconds }), {
  status: 503,
  headers: { "x-laterdog-home": "waking", "retry-after": String(seconds), "content-type": "application/json" },
});
const sentBodies = (requests: ReturnType<typeof vi.fn<typeof fetch>>, path = "/api/bots/bot/messages") =>
  requests.mock.calls.filter(([called]) => called === path).map(([, init]) => JSON.parse(String(init?.body)));

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function manualTimers() {
  const waiting: Array<{ ms: number; run: () => void }> = [];
  const after = (ms: number, run: () => void) => {
    const timer = { ms, run };
    waiting.push(timer);
    return () => {
      const at = waiting.indexOf(timer);
      if (at >= 0) waiting.splice(at, 1);
    };
  };
  const fire = async () => {
    waiting.shift()?.run();
    await answered();
  };
  return { waiting, after, fire };
}

async function answered() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe("a send over a flaky network", () => {
  it("keeps one send id through the retries, so the server can keep one message", async () => {
    const requests = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(async () => accepted());
    const store = mount(requests);
    const onError = vi.fn();
    store.dispatch({ type: "send", botId: "bot", threadId: "thread", text: "ship it", onError });
    await vi.advanceTimersByTimeAsync(10_000);
    const bodies = sentBodies(requests);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((body) => body.sendId)).size).toBe(1);
    expect(bodies[0].sendId).toMatch(/^[\w-]{16,80}$/);
    expect(onError).not.toHaveBeenCalled();
  });

  it("holds the message while the connection stays down instead of giving the words back", async () => {
    const requests = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const store = mount(requests);
    const onError = vi.fn();
    store.dispatch({ type: "send", botId: "bot", threadId: "thread", text: "ship it", onError });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const held = sentBodies(requests);
    expect(held.length).toBeGreaterThan(6);
    expect(new Set(held.map((body) => body.sendId)).size).toBe(1);
    expect(onError).not.toHaveBeenCalled();

    requests.mockReset();
    requests.mockImplementation(async () => accepted());
    await vi.advanceTimersByTimeAsync(15_000);
    const delivered = sentBodies(requests);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].sendId).toBe(held[0].sendId);
  });

  it("waits as long as the waking home asks before sending again", async () => {
    const requests = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(waking(4))
      .mockImplementation(async () => accepted());
    const store = mount(requests);
    store.dispatch({ type: "send", botId: "bot", threadId: "thread", text: "wake up" });
    await vi.advanceTimersByTimeAsync(3_900);
    expect(sentBodies(requests)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(sentBodies(requests)).toHaveLength(2);
  });

  it("does not retry an answer the server meant", async () => {
    const requests = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: "this queued sendId was cancelled; send a new message to try again" }), { status: 409 }));
    const store = mount(requests);
    const onError = vi.fn();
    store.dispatch({ type: "send", botId: "bot", threadId: "thread", text: "ship it", onError });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sentBodies(requests)).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("posts a dog's second message only after the first one is accepted", async () => {
    let release!: () => void;
    const first = new Promise<Response>((resolve) => { release = () => resolve(accepted()); });
    let held = false;
    const requests = vi.fn<typeof fetch>(async (_path, init) => {
      if (!held && String(init?.body).includes('"one"')) {
        held = true;
        return first;
      }
      return accepted();
    });
    const store = mount(requests);
    store.dispatch({ type: "send", botId: "bot", threadId: "thread", text: "one" });
    store.dispatch({ type: "send", botId: "bot", threadId: "thread", text: "two" });
    store.dispatch({ type: "sendGroup", groupId: "team", threadId: "room", text: "three" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sentBodies(requests).map((body) => body.text)).toEqual(["one"]);
    expect(sentBodies(requests, "/api/groups/team/messages").map((body) => body.text)).toEqual(["three"]);
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sentBodies(requests).map((body) => body.text)).toEqual(["one", "two"]);
  });
});

describe("the saved desktop outbox", () => {
  const held: OutboxItem = {
    sendId: "held-send",
    threadId: "thread",
    target: { kind: "bot", botId: "bot" },
    text: "still here",
    queuedAt: 5,
    recovery: { draftId: "bot:bot:thread", text: "still here" },
  };

  it("brings a held message back after a reload, shows it once and delivers it once", async () => {
    const store = memoryStore({ [OUTBOX_KEY]: JSON.stringify({ version: 1, items: [held] }) });
    const request = vi.fn(async () => ({ ok: true, threadId: "thread", message: { id: "real", at: 9, role: "user", kind: "text", text: "still here", sendId: "held-send" } }));
    const dispatched: Action[] = [];
    const outbox = createSendOutbox({ request, dispatch: (action) => dispatched.push(action), showError: vi.fn(), store });
    const pending = outbox.pending([{ messages: [] }], []);
    expect(pending.map((item) => item.sendId)).toEqual(["held-send"]);

    const bot = { id: "bot", threadId: "thread", messages: [], activeLeafId: null } as unknown as Bot;
    const state = reducer({ ...initialState, bots: [bot] } as AppState, { type: "outboxShown", items: pending });
    const shown = reducer(state, { type: "outboxShown", items: pending });
    expect(shown.bots[0]!.messages.filter((message) => message.sendId === "held-send")).toHaveLength(1);
    expect(shown.bots[0]!.messages[0]).toMatchObject({ id: "optimistic-held-send", at: 5, text: "still here" });

    outbox.resume();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((request.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ sendId: "held-send", threadId: "thread" });
    expect(dispatched).toContainEqual(expect.objectContaining({ type: "messageAdded", threadId: "thread" }));
    expect(store.values.has(OUTBOX_KEY)).toBe(false);
  });

  it("drops a held message the home already has instead of sending it again", () => {
    const store = memoryStore({ [OUTBOX_KEY]: JSON.stringify({ version: 1, items: [held] }) });
    const request = vi.fn();
    const outbox = createSendOutbox({ request, dispatch: vi.fn(), showError: vi.fn(), store });
    const landed = { messages: [{ id: "real", role: "user", kind: "text", at: 9, sendId: "held-send" }] } as unknown as Bot;
    expect(outbox.pending([landed], [])).toEqual([]);
    expect(store.values.has(OUTBOX_KEY)).toBe(false);
    outbox.resume();
    expect(request).not.toHaveBeenCalled();
  });

  it("takes a waiting copy in the dog's queue as delivered", () => {
    const store = memoryStore({ [OUTBOX_KEY]: JSON.stringify({ version: 1, items: [held] }) });
    const dispatched: Action[] = [];
    const outbox = createSendOutbox({ request: vi.fn(), dispatch: (action) => dispatched.push(action), showError: vi.fn(), store });
    outbox.queued({ thread: [{ queueId: "q", text: "still here", sendId: "held-send" }] });
    expect(dispatched).toEqual([{ type: "optimisticMessageRemoved", threadId: "thread", sendId: "held-send" }]);
    expect(store.values.has(OUTBOX_KEY)).toBe(false);
  });

  it("shows an undelivered message as Not sent yet and leaves the dog idle until the server takes it", async () => {
    const store = memoryStore();
    let state = { ...initialState, bots: [{ id: "bot", threadId: "thread", messages: [], activeLeafId: null, busy: false } as unknown as Bot] } as AppState;
    const apply = (action: Action) => { state = reducer(state, action); };
    const request = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const outbox = createSendOutbox({ request, dispatch: apply, showError: vi.fn(), store, after: () => () => {} });
    apply({ type: "send", botId: "bot", threadId: "thread", text: "ship it", sendId: "s1" });
    expect(state.bots[0]!.messages[0]).toMatchObject({ id: "optimistic-s1" });
    expect(state.bots[0]!.messages[0]!.held).toBeUndefined();
    outbox.send({ sendId: "s1", threadId: "thread", target: { kind: "bot", botId: "bot" }, text: "ship it", queuedAt: 1 });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(state.bots[0]!.messages[0]).toMatchObject({ id: "optimistic-s1", held: true });
    expect(state.bots[0]!.busy).toBe(false);
    expect(renderToStaticMarkup(createElement(SendingTrack, { at: 1, held: true }))).toContain("Not sent yet");
    expect(renderToStaticMarkup(createElement(SendingTrack, { at: 1 }))).not.toContain("Not sent yet");
    outbox.dispose();
  });

  it("brings a reloaded outbox message back already marked Not sent yet", () => {
    const bot = { id: "bot", threadId: "thread", messages: [], activeLeafId: null } as unknown as Bot;
    const shown = reducer({ ...initialState, bots: [bot] } as AppState, { type: "outboxShown", items: [held] });
    expect(shown.bots[0]!.messages[0]).toMatchObject({ id: "optimistic-held-send", held: true });
  });

  it("puts a refused message that came back from a reload in the Not sent row", async () => {
    const store = memoryStore({ [OUTBOX_KEY]: JSON.stringify({ version: 1, items: [held] }) });
    const refusal = Object.assign(new Error("That dog is gone."), { name: "ApiError", status: 404 });
    const showError = vi.fn();
    const outbox = createSendOutbox({ request: vi.fn(async () => { throw refusal; }), dispatch: vi.fn(), showError, store });
    outbox.resume();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(showError).toHaveBeenCalledWith(refusal, "thread");
    expect(failedComposerSends("bot:bot:thread")).toEqual([
      expect.objectContaining({ sendId: "held-send", text: "still here", requestText: "still here", threadId: "thread" }),
    ]);
  });
});

describe("a message the edge held for a sleeping home", () => {
  const draft = "bot:bot:thread";
  const sent: OutboxItem = { sendId: "edge-held-send-0001", threadId: "thread", target: { kind: "bot", botId: "bot" }, text: "wake up and ship it", queuedAt: 1, recovery: { draftId: draft, text: "wake up and ship it" } };
  const heldReceipt = { ok: true, queued: true, queueId: sent.sendId, threadId: "thread" };
  const kept = (store: ReturnType<typeof memoryStore>) => JSON.parse(store.values.get(HELD_SENDS_KEY) ?? "[]") as Array<{ sendId: string; text: string }>;
  const holding = async (answer: (path: string) => Promise<unknown>, clock = { now: 1_000 }) => {
    const store = memoryStore();
    const showError = vi.fn();
    const timers = manualTimers();
    const request = vi.fn(async (path: string) => (path === "/api/bots/bot/messages" ? heldReceipt : answer(path)));
    const outbox = createSendOutbox({ request, dispatch: vi.fn(), showError, store, now: () => clock.now, after: timers.after });
    outbox.send(sent);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const asks = () => request.mock.calls.filter(([path]) => String(path).startsWith("/api/held-sends")).map(([path]) => String(path));
    return { store, showError, request, outbox, clock, timers, asks };
  };
  const failedBefore = () => failedComposerSends(draft).length;
  const chatState = () => ({
    ...initialState,
    bots: [{ id: "bot", threadId: "thread", messages: [], activeLeafId: null, busy: false } as unknown as Bot],
    groups: [{ id: "team", threadId: "room-thread", messages: [] } as unknown as AppState["groups"][number]],
  } as AppState);

  it("keeps the words on this device when the receipt's queue id is the send id", async () => {
    const { store } = await holding(async () => ({ held: [sent.sendId], dropped: [] }));
    expect(kept(store)).toEqual([expect.objectContaining({ sendId: sent.sendId, text: "wake up and ship it", threadId: "thread", draftId: draft })]);
    expect(store.values.has(OUTBOX_KEY)).toBe(false);
  });

  it("forgets the copy without asking once the message is in the chat or in the dog's queue", async () => {
    const { store, request, outbox } = await holding(async () => { throw new Error("not asked"); });
    await outbox.settleHeld([{ messages: [{ id: "m1", sendId: sent.sendId }] } as never], []);
    expect(kept(store)).toEqual([]);
    expect(request.mock.calls.some(([path]) => String(path).startsWith("/api/held-sends"))).toBe(false);

    const again = await holding(async () => { throw new Error("not asked"); });
    await again.outbox.settleHeld([], [], { thread: [{ queueId: "home-queue-1", sendId: sent.sendId, text: "wake up and ship it" }] });
    expect(kept(again.store)).toEqual([]);
  });

  it("keeps the copy through a refresh the edge answers while it still holds the message, then says Not sent when the edge drops it", async () => {
    const before = failedBefore();
    let answer: unknown = { held: [sent.sendId], dropped: [] };
    const { store, showError, request, outbox } = await holding(async () => answer);
    const asks = () => request.mock.calls.filter(([path]) => String(path).startsWith("/api/held-sends")).length;
    const waitingAtEdge = { id: sent.sendId, path: "/api/bots/bot/messages", headers: {}, body: JSON.stringify({ text: sent.text, sendId: sent.sendId, threadId: "thread" }), at: 1, threadId: "thread" };
    const saved = { bots: [{ id: "bot", threadId: "thread", messages: [], activeLeafId: null }], botQueuedMessages: {} };
    type Served = { bots: Array<Pick<Bot, "messages">>; botQueuedMessages: Record<string, unknown[]> };

    const asRow = withDeskQueue(saved, [waitingAtEdge]) as Served;
    expect(asRow.botQueuedMessages).toEqual({ thread: [{ queueId: sent.sendId, text: sent.text, sendId: sent.sendId }] });
    await outbox.settleHeld(asRow.bots, [], asRow.botQueuedMessages);
    expect(kept(store)).toHaveLength(1);
    expect(asks()).toBe(1);

    const asLines = withDeskQueue(saved, [{ ...waitingAtEdge, reply: { text: "On it.", model: "fixture" } }]) as Served;
    expect(asLines.bots[0]!.messages.map((message) => [message.id, message.sendId])).toEqual([[`desk-${sent.sendId}`, sent.sendId], [`desk-${sent.sendId}-reply`, undefined]]);
    await outbox.settleHeld(asLines.bots, [], asLines.botQueuedMessages);
    expect(kept(store)).toHaveLength(1);
    expect(asks()).toBe(2);
    expect(showError).not.toHaveBeenCalled();

    answer = { held: [], dropped: [{ id: sent.sendId, why: "refused", at: 9 }] };
    await outbox.settleHeld([{ messages: [] }], [], {});
    expect(kept(store)).toEqual([]);
    expect(failedComposerSends(draft).slice(before)).toEqual([expect.objectContaining({ sendId: sent.sendId, text: "wake up and ship it" })]);
    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ message: HELD_NOT_SENT }), "thread");
  });

  it("puts the message in the Not sent row with its words when the edge says the home refused it or the hour ran out", async () => {
    const before = failedBefore();
    const { store, showError, request, outbox } = await holding(async () => ({ held: [], dropped: [{ id: sent.sendId, why: "refused", at: 5 }] }));
    await outbox.settleHeld([], []);
    expect(request).toHaveBeenCalledWith(`/api/held-sends?ids=${sent.sendId}`, expect.objectContaining({ rideWake: false }));
    expect(kept(store)).toEqual([]);
    expect(failedComposerSends(draft).slice(before)).toEqual([expect.objectContaining({ sendId: sent.sendId, text: "wake up and ship it", requestText: "wake up and ship it", threadId: "thread" })]);
    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ message: HELD_NOT_SENT }), "thread");
    await outbox.settleHeld([], []);
    expect(failedComposerSends(draft).slice(before)).toHaveLength(1);
  });

  it("after a drop, shows the message sent again as queued and trusts the edge that holds it over the old drop", async () => {
    const before = failedBefore();
    let state = { ...initialState, bots: [{ id: "bot", threadId: "thread", messages: [], activeLeafId: null, busy: false } as unknown as Bot] } as AppState;
    const apply = (action: Action) => { state = reducer(state, action); };
    const store = memoryStore();
    const showError = vi.fn();
    const drop = { id: sent.sendId, why: "refused", at: 5 };
    let answer: unknown = { held: [], dropped: [drop] };
    const request = vi.fn(async (path: string) => (path === "/api/bots/bot/messages" ? heldReceipt : answer));
    const outbox = createSendOutbox({ request, dispatch: apply, showError, store, after: () => () => {} });
    const sendIt = async () => {
      apply({ type: "send", botId: "bot", threadId: "thread", text: sent.text, sendId: sent.sendId });
      outbox.send(sent);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    const queuedRow = [{ queueId: sent.sendId, text: sent.text }];

    await sendIt();
    expect(state.pendingQueued.thread).toEqual(queuedRow);
    apply({ type: "botQueues", queues: {} });
    await outbox.settleHeld([{ messages: [] }], [], {});
    expect(state.pendingQueued.thread).toBeUndefined();
    expect(showError).toHaveBeenCalledTimes(1);

    answer = { held: [sent.sendId], dropped: [drop] };
    await sendIt();
    expect(state.pendingQueued.thread).toEqual(queuedRow);
    expect(state.bots[0]!.messages).toEqual([]);
    await outbox.settleHeld([{ messages: [] }], [], {});
    expect(kept(store)).toEqual([expect.objectContaining({ sendId: sent.sendId })]);
    expect(showError).toHaveBeenCalledTimes(1);
    expect(failedComposerSends(draft).slice(before)).toHaveLength(1);
  });

  it("settles one refresh at a time, so two refreshes that overlap give one Not sent row and one notice", async () => {
    const before = failedBefore();
    let answerEdge!: (body: unknown) => void;
    const edge = new Promise((resolve) => { answerEdge = resolve; });
    const { store, showError, request, outbox } = await holding(() => edge);
    const refreshes = [outbox.settleHeld([], []), outbox.settleHeld([], []), outbox.settleHeld([], [])];
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(request.mock.calls.filter(([path]) => String(path).startsWith("/api/held-sends"))).toHaveLength(1);
    answerEdge({ held: [], dropped: [{ id: sent.sendId, why: "expired", at: 5 }] });
    await Promise.all(refreshes);
    expect(kept(store)).toEqual([]);
    expect(showError).toHaveBeenCalledTimes(1);
    expect(failedComposerSends(draft).slice(before)).toHaveLength(1);
    expect(request.mock.calls.filter(([path]) => String(path).startsWith("/api/held-sends"))).toHaveLength(1);
  });

  it("runs a refresh that arrived during a settle once more afterwards, with the newest chats", async () => {
    let answerEdge!: (body: unknown) => void;
    const edge = new Promise((resolve) => { answerEdge = resolve; });
    const { store, request, outbox } = await holding(() => edge);
    const first = outbox.settleHeld([], []);
    const stale = outbox.settleHeld([], []);
    const newest = outbox.settleHeld([{ messages: [{ id: "m1", sendId: sent.sendId }] } as never], []);
    answerEdge({ held: [sent.sendId], dropped: [] });
    await Promise.all([first, stale, newest]);
    expect(kept(store)).toEqual([]);
    expect(request.mock.calls.filter(([path]) => String(path).startsWith("/api/held-sends"))).toHaveLength(1);
  });

  it("keeps waiting while the edge still holds it, and lets go quietly once the edge delivered it", async () => {
    const before = failedBefore();
    let answer: unknown = { held: [sent.sendId], dropped: [] };
    const { store, showError, outbox } = await holding(async () => answer);
    await outbox.settleHeld([], []);
    expect(kept(store)).toHaveLength(1);
    answer = { held: [], dropped: [] };
    await outbox.settleHeld([], []);
    expect(kept(store)).toEqual([]);
    expect(showError).not.toHaveBeenCalled();
    expect(failedBefore()).toBe(before);
  });

  it("with no edge to ask, waits out the hour the edge would hold it and then gives the words back", async () => {
    const before = failedBefore();
    const { store, showError, outbox, clock } = await holding(async () => { throw Object.assign(new Error("Not found"), { status: 404 }); });
    clock.now += HELD_GIVE_UP_MS - 1;
    await outbox.settleHeld([], []);
    expect(kept(store)).toHaveLength(1);
    expect(showError).not.toHaveBeenCalled();
    clock.now += 2;
    await outbox.settleHeld([], []);
    expect(kept(store)).toEqual([]);
    expect(failedComposerSends(draft).slice(before)).toEqual([expect.objectContaining({ sendId: sent.sendId, text: "wake up and ship it" })]);
  });

  it("keeps the copy however long asking the edge fails, and settles it only on a real answer", async () => {
    const before = failedBefore();
    let answer: () => unknown = () => { throw new TypeError("Failed to fetch"); };
    const { store, showError, outbox, clock } = await holding(async () => answer());
    clock.now += 3 * HELD_GIVE_UP_MS;
    await outbox.settleHeld([], []);
    answer = () => { throw Object.assign(new Error("signal timed out"), { name: "TimeoutError" }); };
    await outbox.settleHeld([], []);
    answer = () => { throw Object.assign(new Error("Your home is waking up."), { name: "ApiError", status: 503, wake: "waking" }); };
    await outbox.settleHeld([], []);
    answer = () => { throw Object.assign(new Error("Something went wrong."), { name: "ApiError", status: 500 }); };
    await outbox.settleHeld([], []);
    expect(kept(store)).toHaveLength(1);
    expect(showError).not.toHaveBeenCalled();
    expect(failedBefore()).toBe(before);

    answer = () => ({ held: [], dropped: [{ id: sent.sendId, why: "expired", at: 5 }] });
    await outbox.settleHeld([], []);
    expect(kept(store)).toEqual([]);
    expect(failedComposerSends(draft).slice(before)).toHaveLength(1);
  });

  it("asks about fifty messages at a time and settles only the ones it asked about", async () => {
    const before = failedBefore();
    const ids = Array.from({ length: 120 }, (_, index) => `many-held-send-${String(index).padStart(4, "0")}`);
    const store = memoryStore({ [HELD_SENDS_KEY]: JSON.stringify(ids.map((sendId) => ({ sendId, threadId: "thread", draftId: draft, text: sendId, requestText: sendId, at: 1_000 }))) });
    const asks: string[][] = [];
    const request = vi.fn(async (path: string) => {
      const asked = new URL(path, "https://home.test").searchParams.get("ids")!.split(",");
      asks.push(asked);
      if (asks.length === 2) throw new TypeError("Failed to fetch");
      return { held: [], dropped: asks.length === 3 ? asked.map((id) => ({ id, why: "refused", at: 2 })) : [] };
    });
    const showError = vi.fn();
    const outbox = createSendOutbox({ request, dispatch: vi.fn(), showError, store, now: () => 2_000 });
    await outbox.settleHeld([], []);
    expect(asks.map((asked) => asked.length)).toEqual([50, 50, 20]);
    expect(asks.flat()).toEqual(ids);
    expect(kept(store).map((held) => held.sendId)).toEqual(ids.slice(50, 100));
    expect(failedComposerSends(draft).slice(before).map((failed) => failed.sendId)).toEqual(ids.slice(100));
    expect(showError).toHaveBeenCalledTimes(20);
  });

  it("asks the edge by itself while a message is held: after 30 seconds, then twice as long each time up to five minutes, and never from the send", async () => {
    const { timers, asks, showError } = await holding(async () => ({ held: [sent.sendId], dropped: [] }));
    expect(asks()).toEqual([]);
    const waited: number[] = [];
    for (let turn = 1; turn <= 6; turn++) {
      expect(timers.waiting).toHaveLength(1);
      waited.push(timers.waiting[0]!.ms);
      await timers.fire();
      expect(asks()).toHaveLength(turn);
    }
    expect(waited).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(showError).not.toHaveBeenCalled();
  });

  it("learns that the edge dropped the message without any refresh, takes its queued row away, says Not sent once and stops asking", async () => {
    const before = failedBefore();
    let state = chatState();
    const apply = (action: Action) => { state = reducer(state, action); };
    const store = memoryStore();
    const showError = vi.fn();
    const timers = manualTimers();
    let answer: unknown = { held: [sent.sendId], dropped: [] };
    const request = vi.fn(async (path: string) => (path === "/api/bots/bot/messages" ? heldReceipt : answer));
    const outbox = createSendOutbox({ request, dispatch: apply, showError, store, after: timers.after });
    apply({ type: "send", botId: "bot", threadId: "thread", text: sent.text, sendId: sent.sendId });
    outbox.send(sent);
    await answered();
    expect(state.pendingQueued.thread).toEqual([{ queueId: sent.sendId, text: sent.text }]);

    await timers.fire();
    expect(state.pendingQueued.thread).toHaveLength(1);
    expect(showError).not.toHaveBeenCalled();

    answer = { held: [], dropped: [{ id: sent.sendId, why: "expired", at: 9 }] };
    await timers.fire();
    expect(state.pendingQueued.thread).toBeUndefined();
    expect(kept(store)).toEqual([]);
    expect(failedComposerSends(draft).slice(before)).toEqual([expect.objectContaining({ sendId: sent.sendId, text: sent.text })]);
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ message: HELD_NOT_SENT }), "thread");
    expect(timers.waiting).toEqual([]);
  });

  it("after a restart, asks about every held message kept on this device in one request, and a refresh starts the wait over", async () => {
    const before = failedBefore();
    const ids = ["restart-held-send-0001", "restart-held-send-0002"];
    const store = memoryStore({ [HELD_SENDS_KEY]: JSON.stringify(ids.map((sendId) => ({ sendId, threadId: "thread", draftId: draft, text: `words of ${sendId}`, requestText: `words of ${sendId}`, at: 1_000 }))) });
    const timers = manualTimers();
    let answer: unknown = { held: ids, dropped: [] };
    const request = vi.fn(async (_path: string) => answer);
    const showError = vi.fn();
    const outbox = createSendOutbox({ request, dispatch: vi.fn(), showError, store, now: () => 2_000, after: timers.after });
    expect(request).not.toHaveBeenCalled();
    expect(timers.waiting.map((timer) => timer.ms)).toEqual([30_000]);

    await timers.fire();
    await timers.fire();
    expect(request.mock.calls.map(([path]) => path)).toEqual([`/api/held-sends?ids=${ids.join(",")}`, `/api/held-sends?ids=${ids.join(",")}`]);
    expect(timers.waiting.map((timer) => timer.ms)).toEqual([120_000]);

    await outbox.settleHeld([{ messages: [] }], [], {});
    expect(request).toHaveBeenCalledTimes(3);
    expect(timers.waiting.map((timer) => timer.ms)).toEqual([30_000]);

    answer = { held: [ids[0]], dropped: [{ id: ids[1], why: "refused", at: 9 }] };
    await timers.fire();
    expect(kept(store).map((held) => held.sendId)).toEqual([ids[0]]);
    expect(failedComposerSends(draft).slice(before)).toEqual([expect.objectContaining({ sendId: ids[1], text: `words of ${ids[1]}` })]);
    expect(showError).toHaveBeenCalledTimes(1);
    expect(timers.waiting.map((timer) => timer.ms)).toEqual([60_000]);
    outbox.dispose();
  });

  it("stops asking when the edge says to sign in again and when the store goes away, and starts again at the next refresh", async () => {
    let answer: () => unknown = () => { throw Object.assign(new Error("Sign in again."), { name: "ApiError", status: 401 }); };
    const { store, showError, outbox, timers, asks } = await holding(async () => answer());
    await timers.fire();
    expect(asks()).toHaveLength(1);
    expect(timers.waiting).toEqual([]);
    expect(kept(store)).toHaveLength(1);
    expect(showError).not.toHaveBeenCalled();

    answer = () => ({ held: [sent.sendId], dropped: [] });
    await outbox.settleHeld([{ messages: [] }], [], {});
    expect(timers.waiting.map((timer) => timer.ms)).toEqual([30_000]);
    outbox.dispose();
    expect(timers.waiting).toEqual([]);
    await outbox.settleHeld([{ messages: [] }], [], {});
    expect(timers.waiting).toEqual([]);
  });

  it("keeps the copy while the connection is down, and on reconnecting takes the home's word that the message arrived", async () => {
    const before = failedBefore();
    const { store, showError, outbox, timers, asks, clock } = await holding(async () => { throw new TypeError("Failed to fetch"); });
    for (let turn = 0; turn < 3; turn++) {
      clock.now += HELD_GIVE_UP_MS;
      await timers.fire();
    }
    expect(asks()).toHaveLength(3);
    expect(kept(store)).toHaveLength(1);
    expect(timers.waiting.map((timer) => timer.ms)).toEqual([240_000]);

    await outbox.settleHeld([{ messages: [{ id: "home-line-1", sendId: sent.sendId }] } as never], [], {});
    expect(kept(store)).toEqual([]);
    expect(asks()).toHaveLength(3);
    expect(timers.waiting).toEqual([]);
    expect(showError).not.toHaveBeenCalled();
    expect(failedBefore()).toBe(before);
  });

  it("forgets the copy when the person cancels the held message, so it never comes back as Not sent", async () => {
    const before = failedBefore();
    const { store, showError, outbox, timers, asks } = await holding(async () => ({ held: [], dropped: [{ id: sent.sendId, why: "refused", at: 5 }] }));
    outbox.cancelled(sent.sendId);
    expect(kept(store)).toEqual([]);
    expect(timers.waiting).toEqual([]);
    await outbox.settleHeld([{ messages: [] }], [], {});
    expect(asks()).toEqual([]);
    expect(showError).not.toHaveBeenCalled();
    expect(failedBefore()).toBe(before);
  });

  it("does not call a message Not sent, or keep it, when it was cancelled while the edge was being asked", async () => {
    const before = failedBefore();
    for (const lateAnswer of [{ held: [], dropped: [{ id: sent.sendId, why: "expired", at: 5 }] }, { held: [sent.sendId], dropped: [] }]) {
      let answerEdge!: (body: unknown) => void;
      const edge = new Promise((resolve) => { answerEdge = resolve; });
      const { store, showError, outbox, timers } = await holding(() => edge);
      const settling = outbox.settleHeld([{ messages: [] }], [], {});
      await answered();
      outbox.cancelled(sent.sendId);
      answerEdge(lateAnswer);
      await settling;
      expect(kept(store)).toEqual([]);
      expect(showError).not.toHaveBeenCalled();
      expect(failedBefore()).toBe(before);
      expect(timers.waiting).toEqual([]);
    }
  });

  it("keeps one copy and one queued row when the same send is sent again while the edge holds it", async () => {
    let state = chatState();
    const apply = (action: Action) => { state = reducer(state, action); };
    const store = memoryStore();
    const timers = manualTimers();
    const request = vi.fn(async (path: string) => (path === "/api/bots/bot/messages" ? heldReceipt : { held: [sent.sendId], dropped: [] }));
    const outbox = createSendOutbox({ request, dispatch: apply, showError: vi.fn(), store, after: timers.after });
    for (let attempt = 0; attempt < 3; attempt++) {
      apply({ type: "send", botId: "bot", threadId: "thread", text: sent.text, sendId: sent.sendId });
      outbox.send(sent);
      await answered();
    }
    const posts = request.mock.calls.filter(([path]) => path === "/api/bots/bot/messages").map(([, init]) => JSON.parse(String((init as unknown as RequestInit).body)).sendId);
    expect(posts).toEqual([sent.sendId, sent.sendId, sent.sendId]);
    expect(kept(store).map((held) => held.sendId)).toEqual([sent.sendId]);
    expect(state.pendingQueued.thread).toEqual([{ queueId: sent.sendId, text: sent.text }]);
    expect(state.bots[0]!.messages).toEqual([]);
    expect(timers.waiting).toHaveLength(1);
  });

  it("keeps a copy for a send with no composer behind it, and brings its words back as Not sent in its own chat", async () => {
    const quickReply: OutboxItem = { sendId: "quick-reply-send-0001", threadId: "thread", target: { kind: "bot", botId: "bot" }, text: "Yes, go ahead", queuedAt: 1 };
    const before = failedBefore();
    const store = memoryStore();
    const showError = vi.fn();
    let answer: unknown = { held: [quickReply.sendId], dropped: [] };
    const request = vi.fn(async (path: string) => (path === "/api/bots/bot/messages" ? { ok: true, queued: true, queueId: quickReply.sendId, threadId: "thread" } : answer));
    const outbox = createSendOutbox({ request, dispatch: vi.fn(), showError, store, after: manualTimers().after });
    outbox.send(quickReply);
    await answered();
    expect(kept(store)).toEqual([expect.objectContaining({ sendId: quickReply.sendId, threadId: "thread", draftId: draft, text: "Yes, go ahead", requestText: "Yes, go ahead" })]);

    answer = { held: [], dropped: [{ id: quickReply.sendId, why: "refused", at: 5 }] };
    await outbox.settleHeld([{ messages: [] }], [], {});
    expect(kept(store)).toEqual([]);
    expect(failedComposerSends(draft).slice(before)).toEqual([expect.objectContaining({ sendId: quickReply.sendId, text: "Yes, go ahead", requestText: "Yes, go ahead", threadId: "thread" })]);
    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ message: HELD_NOT_SENT }), "thread");
  });

  it("does the same for a group chat: a held group message keeps its row and copy, and a drop takes the row away and gives the words back", async () => {
    const roomDraft = "group:team:room-thread";
    const roomSend: OutboxItem = { sendId: "room-held-send-0001", threadId: "room-thread", target: { kind: "group", groupId: "team" }, text: "Room, wake up", queuedAt: 1 };
    const before = failedComposerSends(roomDraft).length;
    let state = chatState();
    const apply = (action: Action) => { state = reducer(state, action); };
    const store = memoryStore();
    const showError = vi.fn();
    let answer: unknown = { held: [roomSend.sendId], dropped: [] };
    const request = vi.fn(async (path: string) => (path === "/api/groups/team/messages" ? { ok: true, queued: true, queueId: roomSend.sendId, threadId: "room-thread" } : answer));
    const outbox = createSendOutbox({ request, dispatch: apply, showError, store, after: manualTimers().after });
    apply({ type: "sendGroup", groupId: "team", threadId: "room-thread", text: roomSend.text, sendId: roomSend.sendId });
    outbox.send(roomSend);
    await answered();
    expect(state.pendingQueued["room-thread"]).toEqual([{ queueId: roomSend.sendId, text: roomSend.text }]);
    expect(state.groups[0]!.messages).toEqual([]);
    expect(kept(store)).toEqual([expect.objectContaining({ sendId: roomSend.sendId, threadId: "room-thread", draftId: roomDraft, text: roomSend.text })]);

    await outbox.settleHeld(state.bots, state.groups, {});
    expect(state.pendingQueued["room-thread"]).toHaveLength(1);

    answer = { held: [], dropped: [{ id: roomSend.sendId, why: "expired", at: 5 }] };
    await outbox.settleHeld(state.bots, state.groups, {});
    expect(state.pendingQueued["room-thread"]).toBeUndefined();
    expect(kept(store)).toEqual([]);
    expect(failedComposerSends(roomDraft).slice(before)).toEqual([expect.objectContaining({ sendId: roomSend.sendId, text: roomSend.text, threadId: "room-thread" })]);
    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ message: HELD_NOT_SENT }), "room-thread");

    apply({ type: "sendGroup", groupId: "team", threadId: "room-thread", text: roomSend.text, sendId: roomSend.sendId });
    answer = { held: [roomSend.sendId], dropped: [] };
    outbox.send(roomSend);
    await answered();
    expect(state.pendingQueued["room-thread"]).toEqual([{ queueId: roomSend.sendId, text: roomSend.text }]);
  });

  it("takes a held group message's queued row away once a refresh shows it in the chat under the home's own queue id", () => {
    const waiting = { ...chatState(), pendingQueued: { "room-thread": [{ queueId: "room-held-send-0002", text: "Room, wake up" }, { queueId: "home-queue-7", text: "still waiting" }] } } as AppState;
    const landed = { id: "room-line-1", role: "user", kind: "text", text: "Room, wake up", at: 9, sendId: "room-held-send-0002", queueId: "home-queue-3" };
    const refreshed = reducer(waiting, { type: "hydrate", bots: waiting.bots, groups: [{ ...waiting.groups[0]!, messages: [landed] }], sections: [], computerControl: {}, botQueuedMessages: {} } as unknown as Action);
    expect(refreshed.pendingQueued["room-thread"]).toEqual([{ queueId: "home-queue-7", text: "still waiting" }]);
  });

  it("does not keep a copy for a message the home itself queued under its own id", async () => {
    const store = memoryStore();
    const request = vi.fn(async () => ({ ok: true, queued: true, queueId: "home-queue-9", threadId: "thread" }));
    const outbox = createSendOutbox({ request, dispatch: vi.fn(), showError: vi.fn(), store });
    outbox.send(sent);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(kept(store)).toEqual([]);
  });
});

describe("requests while the home wakes up", () => {
  it("waits out a waking home for ordinary requests and answers once it is up", async () => {
    vi.useFakeTimers();
    const requests = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(waking(2))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", requests);
    const answer = api("/api/instances");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(answer).resolves.toEqual({ ok: true });
    expect(requests).toHaveBeenCalledTimes(2);
  });

  it("says the home is waking in words, never as a bare code, when asked not to wait", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => waking(3)));
    await expect(api("/api/bots/bot/messages", { method: "POST", body: "{}", rideWake: false })).rejects.toMatchObject({
      status: 503,
      wake: "waking",
      retryAfterMs: 3_000,
      message: expect.stringMatching(/waking up/),
    });
  });

  it("stops waiting after two minutes and says so", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => waking(15)));
    const answer = api("/api/instances");
    const settled = answer.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(await settled).toMatchObject({ wake: "waking", message: expect.stringMatching(/longer than usual/) });
  });
});
