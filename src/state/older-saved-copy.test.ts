// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESK_CHATS_MAX_BYTES, deskAnswerWithQueue, deskKey, saveAnswer, savedAnswer, type DeskBucket, type DeskObject, type QueuedSend,
} from "../../deploy/laterdog/home/src/desk.ts";
import { deskReplyId, deskUserId } from "../../deploy/laterdog/home/src/desk-stream.ts";
import type { AppState, BotAnnouncement, Group, Message } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

function memoryBucket(): DeskBucket {
  const objects = new Map<string, { bytes: ArrayBuffer; httpMetadata: { contentType: string }; customMetadata: Record<string, string> }>();
  return {
    async get(key): Promise<DeskObject | null> {
      const stored = objects.get(key);
      return stored ? { body: new Response(stored.bytes.slice(0)).body, httpMetadata: stored.httpMetadata, customMetadata: stored.customMetadata } : null;
    },
    async put(key, value, options) { objects.set(key, { bytes: value, ...options }); },
    async delete(keys) { for (const key of [keys].flat()) objects.delete(key); },
    async list({ prefix }) { return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false }; },
  };
}

const line = (id: string, role: Message["role"], text: string, at: number, parentId: string | null, extra: Partial<Message> = {}): Message =>
  ({ id, role, kind: "text", text, at, parentId, ...extra });

const hello = line("hello", "bot", "Hi, I'm Archivist. What would you like me to do?", 1, null);
const ask = line("ask-1", "user", "Where does the release stand?", 2, "hello", { sendId: "older-copy-send-0001" });
const answer = line("answer-1", "bot", "Answer 0015. The checklist is done.", 3, "ask-1");
const newestAsk = line("ask-2", "user", "Anything still waiting on me?", 10, "answer-1", { sendId: "older-copy-send-0002" });
const newestAnswer = line("answer-2", "bot", "Answer 0019. Two items need you.", 11, "ask-2");
const roomOpening = line("room-1", "user", "Room, good morning", 2, null);
const roomNewest = line("room-2", "bot", "Good morning. Nothing is waiting.", 12, null);

const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "Archivist", title: "", description: "",
  notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "codex", model: "gpt" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
};
const room: Group = {
  id: "room", threadId: "room-thread", name: "Room", memberIds: ["bot"],
  defaultResponder: { kind: "member", botId: "bot" }, bulletin: "", unread: false, createdAt: 1, messages: [],
};
const chats = (dogLines: Message[], roomLines: Message[]) => ({
  bots: [{ ...bot, messages: dogLines, activeLeafId: dogLines.at(-1)?.id ?? null }],
  groups: [{ ...room, messages: roomLines }],
  botQueuedMessages: {},
});
const peripherals: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/helpers": { helpers: {} },
  "/api/held-sends": { held: [], dropped: [] },
};

const { StoreProvider, useStore, visibleMessages } = await import("./store");

const HOME = "older-copy-home";
const DEVICE = "older-copy-device";
const ORIGIN = "https://home.example";

interface Edge {
  homeChats: unknown;
  homeUp: boolean;
  held: QueuedSend[];
}

let seen!: AppState;
function Probe() {
  seen = useStore().state;
  return null;
}
let root: Root | null = null;
let cursor = 0;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const frame = async (value: object) => {
  FixtureEventSource.opened.at(-1)!.send(value, `run:${++cursor}`);
  await settle();
};
const reconnect = () => frame({ kind: "hello", resumed: false, cursor: `run:${cursor}` });

async function mount(edge: Edge) {
  const bucket = memoryBucket();
  FixtureEventSource.opened = [];
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (!path.startsWith("/api/bots?")) return new Response(JSON.stringify(peripherals[path.split("?")[0]!] ?? {}));
    const where = await deskKey(HOME, DEVICE, `${ORIGIN}${path}`);
    if (edge.homeUp) {
      const fromHome = new Response(JSON.stringify(edge.homeChats), { headers: { "content-type": "application/json" } });
      await saveAnswer(bucket, where, fromHome.clone(), DESK_CHATS_MAX_BYTES, Date.now());
      return fromHome;
    }
    const saved = await savedAnswer(bucket, where, Date.now());
    if (!saved) return new Response("{}", { status: 503, headers: { "x-laterdog-home": "waking", "retry-after": "1" } });
    return edge.held.length ? deskAnswerWithQueue(saved, edge.held) : saved;
  }));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  await reconnect();
}

const dogLines = () => visibleMessages(seen.bots[0]!).map((message) => message.id);
const roomLines = () => seen.groups[0]!.messages.map((message) => message.id);

async function exchangeThenSleep(edge: Edge) {
  await mount(edge);
  expect(dogLines()).toEqual(["hello", "ask-1", "answer-1"]);
  await frame({ kind: "message", threadId: "thread", message: newestAsk });
  await frame({ kind: "message", threadId: "thread", message: newestAnswer });
  await frame({ kind: "message", threadId: "room-thread", message: roomNewest });
  expect(dogLines()).toEqual(["hello", "ask-1", "answer-1", "ask-2", "answer-2"]);
  expect(roomLines()).toEqual(["room-1", "room-2"]);
  edge.homeUp = false;
  await reconnect();
}

afterEach(() => {
  root?.unmount();
  root = null;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a refresh the edge answers from its older saved copy", () => {
  it("keeps the newest question and answer on screen while the home wakes, and shows each once when the home is up", async () => {
    const edge: Edge = { homeChats: chats([hello, ask, answer], [roomOpening]), homeUp: true, held: [] };
    await exchangeThenSleep(edge);
    expect(dogLines()).toEqual(["hello", "ask-1", "answer-1", "ask-2", "answer-2"]);
    expect(roomLines()).toEqual(["room-1", "room-2"]);

    await reconnect();
    expect(dogLines()).toEqual(["hello", "ask-1", "answer-1", "ask-2", "answer-2"]);
    expect(roomLines()).toEqual(["room-1", "room-2"]);

    edge.homeChats = chats([hello, ask, answer, newestAsk, newestAnswer], [roomOpening, roomNewest]);
    edge.homeUp = true;
    await reconnect();
    expect(seen.bots[0]!.messages.map((message) => message.id)).toEqual(["hello", "ask-1", "answer-1", "ask-2", "answer-2"]);
    expect(roomLines()).toEqual(["room-1", "room-2"]);
  });

  it("still drops a message the home no longer has once the home itself answers", async () => {
    const edge: Edge = { homeChats: chats([hello, ask, answer], [roomOpening]), homeUp: true, held: [] };
    await exchangeThenSleep(edge);

    edge.homeChats = chats([hello, ask, answer], [roomOpening]);
    edge.homeUp = true;
    await reconnect();
    expect(seen.bots[0]!.messages.map((message) => message.id)).toEqual(["hello", "ask-1", "answer-1"]);
    expect(roomLines()).toEqual(["room-1"]);
  });

  it("shows a message the edge answered itself after the newest exchange, not in place of it", async () => {
    const heldId = "older-copy-send-0003";
    const edge: Edge = { homeChats: chats([hello, ask, answer], [roomOpening]), homeUp: true, held: [] };
    await exchangeThenSleep(edge);
    edge.held = [{
      id: heldId, path: "/api/bots/bot/messages", headers: {}, at: 20, threadId: "thread",
      body: JSON.stringify({ text: "And the pricing line?", sendId: heldId, threadId: "thread" }),
      reply: { text: "Still to confirm before Friday.", model: "included" },
    }];
    await reconnect();
    expect(seen.bots[0]!.messages.map((message) => message.id)).toEqual(["hello", "ask-1", "answer-1", "ask-2", "answer-2", deskUserId(heldId), deskReplyId(heldId)]);
    expect(dogLines()).toEqual(["hello", "ask-1", "answer-1", "ask-2", "answer-2", deskUserId(heldId), deskReplyId(heldId)]);
  });
});
