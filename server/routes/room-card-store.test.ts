import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, readBody } from "../harness/http.ts";
import type { Message, Store } from "../store.ts";
import { createRoomCardRoutes, roomOwnsThread } from "./room-card.ts";
import { dispatchRoutes } from "./table.ts";

let home = "";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); })));
  const { closeMessageDb } = await import("../message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

async function freshStore(savedRooms?: unknown[]): Promise<Store> {
  home = mkdtempSync(join(tmpdir(), "laterdog-room-card-store-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { DATA_DIR } = await import("../config.ts");
  if (savedRooms) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "groups.json"), JSON.stringify(savedRooms), { mode: 0o600 });
  }
  const { Store } = await import("../store.ts");
  return new Store(() => ({ instanceId: "claude", model: "m" }));
}

const question = { role: "bot", kind: "options", text: "", card: { title: "Pick", subtitle: "", options: ["Red", "Blue"] } } as unknown as Omit<Message, "id" | "at">;

async function serve(store: Store) {
  const route = createRoomCardRoutes({
    room: (id) => store.group(id),
    threadBelongsToRoom: roomOwnsThread(store),
    messages: (threadId) => store.messagesFor(threadId),
    refusal: () => null,
    answeredBy: () => undefined,
    save: (threadId, messageId, card) => store.patchMessage(threadId, messageId, { card }),
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody })) return;
    json(res, 418, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string, body: unknown) => {
    const answer = await fetch(`${base}${path}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json() as { message?: Message; error?: string } };
  };
}

const answeredOn = (store: Store, threadId: string, messageId: string) => store.messagesFor(threadId).find((line) => line.id === messageId)?.card?.answered;

describe("the room card route with the home's own room check", () => {
  it("saves a card answered in a new room, in a second task of that room and in a direct room", async () => {
    const store = await freshStore();
    const bot = store.createBot();
    const room = store.createGroup("Product", [bot.id]);
    const firstThread = room.threadId;
    const first = store.appendMessage(firstThread, question);
    const task = store.createGroupTask(room.id)!;
    const second = store.appendMessage(task.threadId, question);
    const direct = store.createGroup("Direct", [bot.id, store.createBot().id], true);
    const inDirect = store.appendMessage(direct.threadId, question);
    const patch = await serve(store);

    expect((await patch(`/api/groups/${room.id}/cards/${first.id}`, { answered: "Red", dismissed: true, threadId: firstThread })).status).toBe(200);
    expect((await patch(`/api/groups/${room.id}/cards/${second.id}`, { answered: "Blue", dismissed: true, threadId: task.threadId })).status).toBe(200);
    expect((await patch(`/api/groups/${direct.id}/cards/${inDirect.id}`, { answered: "Red", dismissed: true, threadId: direct.threadId })).status).toBe(200);
    expect(answeredOn(store, firstThread, first.id)).toBe("Red");
    expect(answeredOn(store, task.threadId, second.id)).toBe("Blue");
    expect(answeredOn(store, direct.threadId, inDirect.id)).toBe("Red");
  });

  it("saves a card answered in a room saved before rooms had a task list", async () => {
    const store = await freshStore([{ id: "old-room", threadId: "old-room-thread", name: "Old", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1 }]);
    const card = store.appendMessage("old-room-thread", question);
    const patch = await serve(store);
    const answer = await patch(`/api/groups/old-room/cards/${card.id}`, { answered: "Red", dismissed: true, threadId: "old-room-thread" });
    expect(answer.status).toBe(200);
    expect(answeredOn(store, "old-room-thread", card.id)).toBe("Red");
  });

  it("refuses a thread of another room and a direct room's foreign thread", async () => {
    const store = await freshStore();
    const bot = store.createBot();
    const room = store.createGroup("Product", [bot.id]);
    const other = store.createGroup("Other", [bot.id]);
    const card = store.appendMessage(other.threadId, question);
    const direct = store.createGroup("Direct", [bot.id, store.createBot().id], true);
    const patch = await serve(store);
    expect((await patch(`/api/groups/${room.id}/cards/${card.id}`, { answered: "Red", threadId: other.threadId })).status).toBe(404);
    expect((await patch(`/api/groups/${direct.id}/cards/${card.id}`, { answered: "Red", threadId: other.threadId })).status).toBe(404);
    expect(answeredOn(store, other.threadId, card.id)).toBeUndefined();
  });
});
