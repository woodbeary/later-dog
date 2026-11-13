import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import type { Message } from "../store.ts";
import { createRoomCardRoutes } from "./room-card.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); })));
});

const line = (id: string, card?: Record<string, unknown>) => ({ id, role: "bot", kind: card ? "options" : "text", at: 1, text: "", ...(card ? { card } : {}) }) as unknown as Message;

async function serve(refusal: string | null = null) {
  const threads: Record<string, Message[]> = {
    "room-thread": [line("card-1", { title: "Pick", options: ["Red"] }), line("plain"), line("ask", { title: "Allow?", options: [], requestId: "req-1" })],
    "other-thread": [line("card-1", { title: "Pick", options: ["Red"] })],
  };
  const saves: string[] = [];
  const route = createRoomCardRoutes({
    room: (id) => (id === "room" ? { id, threadId: "room-thread" } : undefined),
    threadBelongsToRoom: (_id, threadId) => threadId === "room-thread",
    messages: (threadId) => threads[threadId] ?? [],
    refusal: () => refusal,
    answeredBy: () => undefined,
    save: (threadId, messageId, card) => {
      saves.push(`${threadId}/${messageId}`);
      const index = threads[threadId]!.findIndex((message) => message.id === messageId);
      threads[threadId]![index] = { ...threads[threadId]![index]!, card } as Message;
      return threads[threadId]![index]!;
    },
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody })) return;
    json(res, 418, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const patch = async (path: string, body: unknown) => {
    const answer = await fetch(`${base}${path}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json() as { message?: Message; error?: string } };
  };
  return { patch, saves, threads };
}

describe("the room card route", () => {
  it("saves an answer on the room's own thread, and a repeat saves nothing more", async () => {
    const { patch, saves, threads } = await serve();
    const first = await patch("/api/groups/room/cards/card-1", { answered: "Red", dismissed: true });
    expect(first.status).toBe(200);
    expect(first.body.message?.card).toMatchObject({ answered: "Red", dismissed: true });
    expect(threads["room-thread"]![0]!.card).toMatchObject({ answered: "Red" });
    const again = await patch("/api/groups/room/cards/card-1", { answered: "Red", dismissed: true });
    expect(again.status).toBe(200);
    expect(saves).toEqual(["room-thread/card-1"]);
  });

  it("refuses an unknown room, message, non-card, request card, foreign thread and a person who may not answer", async () => {
    const { patch, saves } = await serve();
    expect((await patch("/api/groups/nowhere/cards/card-1", { answered: "Red" })).status).toBe(404);
    expect((await patch("/api/groups/room/cards/missing", { answered: "Red" })).body.error).toBe("no such message");
    expect((await patch("/api/groups/room/cards/plain", { answered: "Red" })).body.error).toBe("that message is not a card");
    expect((await patch("/api/groups/room/cards/ask", { answered: "Red" })).status).toBe(409);
    expect((await patch("/api/groups/room/cards/card-1", { answered: "Red", threadId: "other-thread" })).status).toBe(404);
    expect(saves).toEqual([]);
    const guest = await serve("Only the owner of this Cloud can answer this card.");
    expect((await guest.patch("/api/groups/room/cards/card-1", { answered: "Red" })).status).toBe(403);
    expect(guest.saves).toEqual([]);
  });

  it("leaves other paths alone", async () => {
    const { patch } = await serve();
    expect((await patch("/api/groups/room", {})).status).toBe(418);
  });
});
