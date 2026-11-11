import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTBOX_KEY, type OutboxItem } from "@/lib/outbox";
import { failedComposerSends } from "@/lib/drafts";
import { api, initialState, reducer, StoreProvider, useStore, type Action, type AppState, type Bot } from "./store";
import { createSendOutbox } from "./send-outbox";
import { HELD_GIVE_UP_MS, HELD_NOT_SENT, HELD_SENDS_KEY } from "@/lib/held-sends";
import { SendingTrack } from "@/components/SendingTrack";

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
    const request = vi.fn(async (path: string) => (path === "/api/bots/bot/messages" ? heldReceipt : answer(path)));
    const outbox = createSendOutbox({ request, dispatch: vi.fn(), showError, store, now: () => clock.now });
    outbox.send(sent);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return { store, showError, request, outbox, clock };
  };
  const failedBefore = () => failedComposerSends(draft).length;

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
