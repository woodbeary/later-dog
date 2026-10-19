import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTBOX_KEY, type OutboxItem } from "@/lib/outbox";
import { failedComposerSends } from "@/lib/drafts";
import { api, initialState, reducer, StoreProvider, useStore, type Action, type AppState, type Bot } from "./store";
import { createSendOutbox } from "./send-outbox";
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
