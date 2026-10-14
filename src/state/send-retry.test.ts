import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action } from "./store";

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
const sentBodies = (requests: ReturnType<typeof vi.fn<typeof fetch>>) =>
  requests.mock.calls.filter(([path]) => path === "/api/bots/bot/messages").map(([, init]) => JSON.parse(String(init?.body)));

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

  it("gives up in plain words, gives the words back, and does not make a copy when they are sent again", async () => {
    const requests = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const store = mount(requests);
    const onError = vi.fn();
    store.dispatch({ type: "send", botId: "bot", threadId: "thread", text: "ship it", onError });
    await vi.advanceTimersByTimeAsync(60_000);
    const firstBodies = sentBodies(requests);
    expect(firstBodies).toHaveLength(6);
    expect(onError).toHaveBeenCalledTimes(1);

    requests.mockReset();
    requests.mockImplementation(async () => accepted());
    store.dispatch({ type: "send", botId: "bot", threadId: "thread", text: "ship it" });
    await vi.advanceTimersByTimeAsync(1_000);
    const again = sentBodies(requests);
    expect(again).toHaveLength(1);
    expect(again[0].sendId).toBe(firstBodies[0].sendId);

    requests.mockClear();
    store.dispatch({ type: "send", botId: "bot", threadId: "thread", text: "ship it" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sentBodies(requests)[0].sendId).not.toBe(firstBodies[0].sendId);
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
});
