// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "",
  notifications: true, unread: false, color: "green", messages: [],
  modelSelection: { instanceId: "fake", model: "m" },
};
const routine = {
  id: "inbox", name: "Inbox check", prompt: "Check the inbox", target: "bot", botId: "scout", runOn: "dog", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30, nextRunAt: null, createdAt: 0, updatedAt: 0,
};
const calls: string[] = [];
let refuseRun = false;

const { StoreProvider, useStore } = await import("./store");

let seen!: AppState;
let dispatch!: Dispatch<Action>;
function Probe() {
  const store = useStore();
  seen = store.state;
  dispatch = store.dispatch;
  return null;
}
let root: Root;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${path.split("?")[0]}`;
    calls.push(key);
    if (key === "GET /api/bots") return new Response(JSON.stringify({ bots: [bot], groups: [] }));
    if (key === "GET /api/routines") return new Response(JSON.stringify({ routines: [routine], runs: [] }));
    if (key === "GET /api/instances") return new Response(JSON.stringify({ instances: [] }));
    if (key === "POST /api/routines/inbox/run") {
      if (refuseRun) return new Response(JSON.stringify({ error: "Scout is busy" }), { status: 409 });
      return new Response(JSON.stringify({ run: { id: "run-1", routineId: "inbox", status: "running" } }));
    }
    return new Response(JSON.stringify({}));
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened[0]!.send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("running a routine now", () => {
  it("posts to the routine's run route once", async () => {
    expect(seen.routines.map((entry) => entry.id)).toEqual(["inbox"]);
    calls.length = 0;
    dispatch({ type: "runRoutine", routineId: "inbox" });
    await settle();
    expect(calls.filter((call) => call.startsWith("POST "))).toEqual(["POST /api/routines/inbox/run"]);
    expect(seen.paneErrors.routines).toBeUndefined();
  });

  it("shows a refused run in the routines pane", async () => {
    refuseRun = true;
    dispatch({ type: "runRoutine", routineId: "inbox" });
    await settle();
    expect(seen.paneErrors.routines?.line).toBeTruthy();
  });
});
