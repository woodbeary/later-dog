import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { BotRecord, Message } from "../store.ts";
import { json, readBody } from "../harness/http.ts";
import { dispatchInternalRoutes } from "./internal.ts";
import { createReactRoute, REACT_PATH } from "./react.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(active: boolean) {
  const messages: Message[] = [{ id: "m1", role: "user", kind: "text", text: "thanks", at: 1 } as Message];
  const reactedTurns = new Set<string>();
  const pendingTapbackText = new Map<string, string>();
  const routes = [createReactRoute({
    activePath: () => messages,
    patchMessage: (_thread, id, patch) => {
      const message = messages.find((m) => m.id === id);
      if (!message) return null;
      Object.assign(message, patch);
      return message;
    },
    liveTurn: () => "turn-1",
    reactedTurns,
    pendingTapbackText,
    active: () => active,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchInternalRoutes(routes, {
        req, res, url, path: url.pathname, method: req.method ?? "GET", json,
        sender: { id: "dog-1", name: "Rex" } as BotRecord, threadId: "thread-1", capability: {}, readBody: () => readBody(req),
      });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: (error as Error).message });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (body: unknown, method = "POST") => {
    const response = await fetch(`${base}${REACT_PATH}`, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, messages, reactedTurns, pendingTapbackText };
}

describe(`POST ${REACT_PATH}`, () => {
  it("taps back on the person's message and marks the turn as already answered", async () => {
    const { call, messages, reactedTurns, pendingTapbackText } = await serve(true);
    const answer = await call({ emoji: "👍" });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ messageId: "m1", emoji: "👍" });
    expect(messages[0].reactions).toEqual([expect.objectContaining({ emoji: "👍" })]);
    expect(reactedTurns.size).toBe(1);
    expect(pendingTapbackText.size).toBe(1);
  });

  it("refuses a missing emoji, an unknown message and an ended turn, and ignores other requests", async () => {
    const { call } = await serve(true);
    expect(await call({})).toEqual({ status: 400, body: { error: "react needs one emoji, for example 👍." } });
    expect(await call({ emoji: "👍", messageId: "nope" })).toEqual({ status: 404, body: { error: "No message with that id in this chat." } });
    expect(await call({}, "GET")).toEqual({ status: 404, body: { from: "inline routes" } });
    const ended = await serve(false);
    expect(await ended.call({ emoji: "👍" })).toEqual({ status: 401, body: { error: "the internal turn capability has expired" } });
  });
});
