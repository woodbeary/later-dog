// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import type { Action, AppState, BotAnnouncement, Group, Message } from "./store";

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
  notifications: true, unread: false, color: "green", busy: true,
  modelSelection: { instanceId: "codex", model: "gpt" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
};
const room: Group = {
  id: "room", threadId: "room-thread", name: "Room", memberIds: ["bot"],
  defaultResponder: { kind: "member", botId: "bot" }, bulletin: "", unread: false, createdAt: 1,
  busyBotId: "bot", working: true, messages: [],
};
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
  "/api/helpers": { helpers: {} },
};
const hello: Message = { id: "m1", role: "user", kind: "text", text: "hello", at: 5, queueId: "q1" };
const roomHello: Message = { id: "rm1", role: "user", kind: "text", text: "room hello", at: 5, queueId: "rq1" };

const { StoreProvider, useStore } = await import("./store");
const { STILL_QUEUED_LINE } = await import("@/lib/queued-steer");
const { UNREACHABLE_MESSAGE } = await import("@/lib/plain-client-error");

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
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const frame = async (value: ServerFrame) => {
  FixtureEventSource.opened.at(-1)!.send(value, `run:${++cursor}`);
  await settle();
};

async function mount(steerReply: (path: string) => Promise<Response>) {
  FixtureEventSource.opened = [];
  vi.stubGlobal("EventSource", FixtureEventSource);
  const requests = vi.fn((path: string) => {
    if (path.startsWith("/api/bots?")) {
      return Promise.resolve(new Response(JSON.stringify({
        bots: [{ ...bot, messages: [] }],
        groups: [room],
        botQueuedMessages: { thread: [{ queueId: "q1", text: "hello" }] },
      })));
    }
    if (path.endsWith("/steer")) return steerReply(path);
    return Promise.resolve(new Response(JSON.stringify(answers[path] ?? {})));
  });
  vi.stubGlobal("fetch", requests);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened.at(-1)!.send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  flushSync(() => dispatch({ type: "pendingQueued", threadId: "room-thread", queueId: "rq1", text: "room hello" }));
  return requests;
}

const reply = (body: unknown, status = 200) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));
const linesFor = (threadId: string, text: string) =>
  threadId === "thread"
    ? seen.bots.find((candidate) => candidate.id === "bot")!.messages.filter((message) => message.text === text)
    : seen.groups.find((candidate) => candidate.id === "room")!.messages.filter((message) => message.text === text);
const steerBot = async () => {
  const onError = vi.fn(), onSettled = vi.fn();
  flushSync(() => dispatch({ type: "steerQueued", botId: "bot", threadId: "thread", queueId: "q1", onError, onSettled }));
  await settle();
  return { onError, onSettled };
};
const steerRoom = async () => {
  const onError = vi.fn(), onSettled = vi.fn();
  flushSync(() => dispatch({ type: "steerGroupQueued", groupId: "room", threadId: "room-thread", queueId: "rq1", onError, onSettled }));
  await settle();
  return { onError, onSettled };
};

afterEach(() => {
  root?.unmount();
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pressing Steer on a queued message", () => {
  it.each([
    ["steered into the running turn", { ok: true, steered: true, threadId: "thread", queueIds: ["q1"], messages: [{ ...hello, steered: true }] }],
    ["sent as the next turn", { ok: true, sent: true, interrupted: true, threadId: "thread", queueIds: ["q1"], messages: [hello] }],
  ])("clears the queued row and shows the message once when it is %s", async (_, body) => {
    await mount(reply(body));
    expect(seen.pendingQueued.thread).toEqual([{ queueId: "q1", text: "hello" }]);
    const { onError, onSettled } = await steerBot();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(seen.error).toBeNull();
    expect(seen.pendingQueued.thread).toBeUndefined();
    expect(linesFor("thread", "hello")).toHaveLength(1);

    await frame({ kind: "message", threadId: "thread", message: body.messages[0] } as ServerFrame);
    await frame({ kind: "bot.queued", queues: {} } as ServerFrame);
    expect(linesFor("thread", "hello")).toHaveLength(1);
    expect(seen.pendingQueued.thread).toBeUndefined();
  });

  it("shows the server's one plain line when the message could not go yet", async () => {
    const reason = "coordinator hasn't stopped yet. Your message will be sent as soon as it does.";
    await mount(reply({ ok: true, queued: true, threadId: "thread", reason }));
    const { onError, onSettled } = await steerBot();
    expect(onError).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();
    expect(seen.error).toBe(reason);
    expect(seen.pendingQueued.thread).toEqual([{ queueId: "q1", text: "hello" }]);
    expect(linesFor("thread", "hello")).toHaveLength(0);
  });

  it("never ends silently, even when an older server answers only that the message is still queued", async () => {
    await mount(reply({ ok: true, queued: true, threadId: "thread" }));
    const { onError } = await steerBot();
    expect(onError).toHaveBeenCalledOnce();
    expect(seen.error).toBe(STILL_QUEUED_LINE);
  });

  it("says plainly when later.dog could not be reached", async () => {
    await mount(() => Promise.reject(new TypeError("Failed to fetch")));
    const { onError } = await steerBot();
    expect(onError).toHaveBeenCalledOnce();
    expect(seen.error).toBe(UNREACHABLE_MESSAGE);
    expect(seen.pendingQueued.thread).toEqual([{ queueId: "q1", text: "hello" }]);
  });

  it("does the same in a room: the row clears and the message shows once", async () => {
    await mount(reply({ ok: true, sent: true, interrupted: true, threadId: "room-thread", queueIds: ["rq1"], messages: [roomHello] }));
    expect(seen.pendingQueued["room-thread"]).toEqual([{ queueId: "rq1", text: "room hello" }]);
    const { onError } = await steerRoom();
    expect(onError).not.toHaveBeenCalled();
    expect(seen.pendingQueued["room-thread"]).toBeUndefined();
    expect(linesFor("room-thread", "room hello")).toHaveLength(1);
    await frame({ kind: "message", threadId: "room-thread", message: roomHello } as ServerFrame);
    expect(linesFor("room-thread", "room hello")).toHaveLength(1);
  });

  it("shows the room's plain line when its message could not go yet", async () => {
    await mount(reply({ ok: true, queued: true, threadId: "room-thread", reason: "Room hasn't stopped yet. Your message will be sent as soon as it does." }));
    const { onError } = await steerRoom();
    expect(onError).toHaveBeenCalledOnce();
    expect(seen.error).toBe("Room hasn't stopped yet. Your message will be sent as soon as it does.");
    expect(seen.pendingQueued["room-thread"]).toEqual([{ queueId: "rq1", text: "room hello" }]);
  });
});
