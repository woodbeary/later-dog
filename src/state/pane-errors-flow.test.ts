// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "",
  notifications: true, unread: false, color: "green", messages: [],
  modelSelection: { instanceId: "fake", model: "m" },
};
const room = { id: "room", threadId: "room-thread", name: "Room", memberIds: ["bot"], messages: [] } as unknown as Group;
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
};
const failing = new Set<string>();
const calls: string[] = [];
const keyOf = (path: string, init?: RequestInit) => `${init?.method ?? "GET"} ${path.startsWith("/api/bots?") ? "/api/bots" : path}`;

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
  failing.add("GET /api/bots").add("GET /api/routines").add("GET /api/config");
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const key = keyOf(path, init);
    calls.push(key);
    if (failing.has(key)) return new Response(JSON.stringify({ error: "fixture failure" }), { status: 500 });
    if (key === "GET /api/bots") return new Response(JSON.stringify({ bots: [bot], groups: [room] }));
    return new Response(JSON.stringify(answers[path] ?? {}));
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

describe("errors stay in the pane that failed", () => {
  it("puts each failed load in its own pane with Try again, and no global line", () => {
    expect(seen.paneErrors.sidebar).toMatchObject({ line: "Couldn't refresh", retryable: true });
    expect(seen.paneErrors.routines).toMatchObject({ line: "Couldn't load routines", retryable: true });
    expect(seen.paneErrors.dogPanel).toMatchObject({ line: "Couldn't load", retryable: true });
    expect(Object.keys(seen.paneErrors).sort()).toEqual(["dogPanel", "routines", "sidebar"]);
    expect(seen).not.toHaveProperty("error");
  });

  it("clears each pane when its own Try again succeeds, leaving the others alone", async () => {
    failing.clear();
    dispatch({ type: "retryPane", pane: "routines" });
    await settle();
    expect(seen.paneErrors.routines).toBeUndefined();
    expect(seen.routinesLoadState).toBe("ready");
    expect(seen.paneErrors.sidebar).toBeDefined();

    dispatch({ type: "retryPane", pane: "sidebar" });
    await settle();
    expect(seen.paneErrors.sidebar).toBeUndefined();
    expect(seen.bots.map((candidate) => candidate.id)).toEqual(["bot"]);

    dispatch({ type: "retryPane", pane: "dogPanel" });
    await settle();
    expect(seen.paneErrors).toEqual({});
  });

  it("brings the line back when Try again fails too", async () => {
    failing.add("DELETE /api/groups/room");
    dispatch({ type: "deleteGroup", groupId: "room" });
    await settle();
    expect(seen.paneErrors.sidebar).toMatchObject({ retryable: true });
    const first = seen.paneErrors.sidebar!.id;
    dispatch({ type: "retryPane", pane: "sidebar" });
    await settle();
    expect(seen.paneErrors.sidebar?.id).toBeGreaterThan(first);
    expect(calls.filter((call) => call === "DELETE /api/groups/room")).toHaveLength(2);

    failing.clear();
    dispatch({ type: "retryPane", pane: "sidebar" });
    await settle();
    expect(seen.paneErrors.sidebar).toBeUndefined();
    expect(calls.filter((call) => call === "DELETE /api/groups/room")).toHaveLength(3);
  });

  it("shows a failed stop in that conversation, and its Try again stops again", async () => {
    failing.add("POST /api/bots/bot/interrupt");
    const onError = vi.fn();
    dispatch({ type: "interrupt", botId: "bot", threadId: "thread", onError });
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(Object.keys(seen.paneErrors)).toEqual(["chat:thread"]);
    failing.clear();
    dispatch({ type: "retryPane", pane: "chat:thread" });
    await settle();
    expect(seen.paneErrors).toEqual({});
    expect(calls.filter((call) => call === "POST /api/bots/bot/interrupt")).toHaveLength(2);
  });

  it("shows a dog change that fails outside its settings in the open conversation", async () => {
    failing.add("PATCH /api/bots/bot");
    expect(seen.settingsOpen).toBe(false);
    dispatch({ type: "updateBot", botId: "bot", patch: { name: "Renamed" } });
    for (let waited = 0; waited < 40 && !seen.paneErrors["chat:thread"]; waited++) await settle();
    expect(Object.keys(seen.paneErrors)).toEqual(["chat:thread"]);
    expect(seen.paneErrors["chat:thread"]?.line).toBeTruthy();
    failing.clear();
    dispatch({ type: "paneErrorCleared", pane: "chat:thread" });
    await settle();
  });

  it("shows a dog change that fails while its settings are open in the dog panel", async () => {
    failing.add("PATCH /api/bots/bot");
    dispatch({ type: "toggleSettings", botId: "bot", open: true });
    await settle();
    dispatch({ type: "updateBot", botId: "bot", patch: { name: "Renamed again" } });
    for (let waited = 0; waited < 40 && !seen.paneErrors["dogPanel:bot"]; waited++) await settle();
    expect(Object.keys(seen.paneErrors)).toEqual(["dogPanel:bot"]);
    failing.clear();
    dispatch({ type: "paneErrorCleared", pane: "dogPanel:bot" });
    dispatch({ type: "toggleSettings", open: false });
    await settle();
  });

  it("shows a room change made from the sidebar in the open conversation and puts the old name back", async () => {
    expect(seen.selectedId).toBe("bot");
    failing.add("PATCH /api/groups/room");
    dispatch({ type: "patchGroup", groupId: "room", patch: { name: "Renamed" } });
    await settle();
    expect(Object.keys(seen.paneErrors)).toEqual(["chat:thread"]);
    expect(seen.groups.find((group) => group.id === "room")?.name).toBe("Room");
    failing.clear();
    dispatch({ type: "retryPane", pane: "chat:thread" });
    await settle();
    expect(seen.paneErrors).toEqual({});
    expect(seen.groups.find((group) => group.id === "room")?.name).toBe("Renamed");
    expect(calls.filter((call) => call === "PATCH /api/groups/room")).toHaveLength(2);
  });

  it("shows a change to the open room in that room", async () => {
    dispatch({ type: "select", id: "room" });
    await settle();
    failing.add("PATCH /api/groups/room");
    dispatch({ type: "patchGroup", groupId: "room", patch: { name: "Renamed twice" } });
    await settle();
    expect(Object.keys(seen.paneErrors)).toEqual(["chat:room-thread"]);
    expect(seen.groups.find((group) => group.id === "room")?.name).toBe("Renamed");
    failing.clear();
    dispatch({ type: "paneErrorCleared", pane: "chat:room-thread" });
    dispatch({ type: "select", id: "bot" });
    await settle();
  });

  it("clears the conversation lines once the snapshot after a reconnect succeeds", async () => {
    dispatch({ type: "reportError", error: new Error("Picture upload failed"), pane: "chat:thread" });
    await settle();
    expect(seen.paneErrors["chat:thread"]?.line).toBe("Picture upload failed");
    FixtureEventSource.opened.at(-1)!.onerror?.();
    const opened = FixtureEventSource.opened.length;
    for (let waited = 0; waited < 40 && FixtureEventSource.opened.length === opened; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(FixtureEventSource.opened.length).toBeGreaterThan(opened);
    FixtureEventSource.opened.at(-1)!.send({ kind: "hello", resumed: false, cursor: "run:1" });
    await settle();
    expect(seen.paneErrors).toEqual({});
  });
});
