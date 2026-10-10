import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action } from "./store";

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function mount(request: typeof fetch) {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  return (action: Action) => dispatch(action);
}
afterEach(() => { initialState.bots = []; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("a send's delivery", () => {
  it("travels with the words when the person picked one, and stays out when they did not", async () => {
    const requests = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, queued: true, queueId: "q", threadId: "thread" }), { status: 202 }));
    const dispatch = mount(requests);
    dispatch({ type: "send", botId: "bot", threadId: "thread", text: "do this instead", deliver: "stop" });
    dispatch({ type: "send", botId: "bot", threadId: "thread", text: "and this" });
    await flush();
    const bodies = requests.mock.calls
      .filter(([path]) => path === "/api/bots/bot/messages")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      expect.objectContaining({ text: "do this instead", threadId: "thread", deliver: "stop" }),
      expect.not.objectContaining({ deliver: expect.anything() }),
    ]);
    expect(bodies[1].text).toBe("and this");
  });
});
