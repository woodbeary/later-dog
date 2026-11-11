import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALREADY_ANSWERING, DESK_SAVE_EVERY_MS, HELD_UNTIL_UP, SAVED_HEADER } from "../../deploy/laterdog/home/src/desk.ts";
import { WAKE_HEADER } from "../../deploy/laterdog/home/src/waking.ts";
import { DELIVERY_RETRY_MS, HELD_GIVE_UP_MS, startFixtureEdge, type FixtureEdge } from "./fixture-edge.ts";

const SEND_PATH = "/api/bots/dog-1/messages";
const sendId = (label: string) => `${label}-0123456789abcdef`;

interface StandInHome {
  url: string;
  taken: Array<{ sendId: string; text: string }>;
  close(): Promise<void>;
}

async function standInHome(): Promise<StandInHome> {
  const taken: StandInHome["taken"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache" });
        return res.end("<!doctype html><title>home</title>");
      }
      if (req.method === "GET" && path === "/api/bots") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ bots: [{ id: "dog-1", threadId: "thread-1", messages: taken.map((sent) => ({ id: sent.sendId, sendId: sent.sendId, text: sent.text })) }], botQueuedMessages: {} }));
      }
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return void res.write(`data: ${JSON.stringify({ kind: "hello", cursor: "home:1", resumed: false })}\n\n`);
      }
      if (req.method === "POST" && path === SEND_PATH) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { sendId: string; text: string };
        if (!taken.some((earlier) => earlier.sendId === body.sendId)) taken.push({ sendId: body.sendId, text: body.text });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, threadId: "thread-1" }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not here" }));
    });
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    taken,
    close: () => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}

describe("the fixture edge", () => {
  let home: StandInHome;
  let edge: FixtureEdge;
  let clock: number;

  const send = (label: string, text = `words ${label}`) =>
    fetch(`${edge.url}${SEND_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, threadId: "thread-1", sendId: sendId(label) }) });
  const chats = async () => (await fetch(`${edge.url}/api/bots`)).json() as Promise<{ botQueuedMessages: Record<string, Array<{ queueId: string; text: string }>> }>;
  const asked = async (...labels: string[]) => (await fetch(`${edge.url}/api/held-sends?ids=${labels.map(sendId).join(",")}`)).json() as Promise<{ held: string[]; dropped: Array<{ id: string; why: string }> }>;
  const pairAndSleep = async () => {
    await fetch(`${edge.url}/`);
    await chats();
    await new Promise((done) => setTimeout(done, 20));
    edge.sleep();
  };

  beforeEach(async () => {
    clock = Date.now();
    home = await standInHome();
    edge = await startFixtureEdge({ home: home.url, now: () => clock, deliveryRetryMs: 40 });
  });
  afterEach(async () => {
    await edge.close();
    await home.close();
  });

  it("keeps the retry and give-up times the edge uses", () => {
    const host = readFileSync(new URL("../../deploy/laterdog/home/src/host.ts", import.meta.url), "utf8");
    expect(host).toContain(`const DESK_RETRY_S = ${DELIVERY_RETRY_MS / 1000};`);
    expect(host).toContain("const DESK_GIVE_UP_MS = 60 * 60 * 1000;");
    expect(HELD_GIVE_UP_MS).toBe(60 * 60 * 1000);
  });

  it("answers from the home while it serves and from what it saved while the home sleeps", async () => {
    await pairAndSleep();
    const page = await fetch(`${edge.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get(SAVED_HEADER)).toBeTruthy();
    const list = await fetch(`${edge.url}/api/bots`);
    expect(list.headers.get(SAVED_HEADER)).toBeTruthy();
    const unsaved = await fetch(`${edge.url}/api/config`);
    expect(unsaved.status).toBe(503);
    expect(unsaved.headers.get(WAKE_HEADER)).toBe("waking");
    expect(await unsaved.json()).toEqual({ error: "waking", retryAfter: 2 });
    expect(edge.events.filter((event) => event.kind === "told-waking")).toEqual([{ at: clock, kind: "told-waking", status: 503 }]);
    const lending = await fetch(`${edge.url}/api/config`, { headers: { "x-laterdog-lending": "1" } });
    expect(lending.headers.get(WAKE_HEADER)).toBe("asleep");
  });

  it("refuses to hold for a device it has never answered", async () => {
    edge.sleep();
    const reply = await send("stranger");
    expect(reply.status).toBe(503);
    expect(edge.held()).toEqual([]);
  });

  it("holds a send while the home sleeps, shows it in the saved chat list, and delivers it once on wake", async () => {
    await pairAndSleep();
    const first = await send("held");
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ ok: true, queued: true, queueId: sendId("held"), threadId: "thread-1" });
    const again = await send("held");
    expect(again.status).toBe(202);
    expect(edge.held()).toEqual([sendId("held")]);
    expect((await chats()).botQueuedMessages["thread-1"]).toEqual([{ queueId: sendId("held"), text: "words held", sendId: sendId("held") }]);
    expect(await asked("held")).toEqual({ held: [sendId("held")], dropped: [] });
    expect(home.taken).toEqual([]);
    edge.serve();
    await edge.seen("delivered", { id: sendId("held") }, 2_000);
    expect(home.taken).toEqual([{ sendId: sendId("held"), text: "words held" }]);
    expect(await asked("held")).toEqual({ held: [], dropped: [] });
    expect(edge.events.filter((event) => event.kind === "delivered")).toHaveLength(1);
    expect(edge.events.filter((event) => event.kind === "held" || event.kind === "held-again")).toEqual([
      { at: clock, kind: "held", id: sendId("held"), gotAt: clock },
      { at: clock, kind: "held-again", id: sendId("held"), gotAt: clock },
    ]);
  });

  it("answers Send now with a sentence and takes a cancelled message out before the home sees it", async () => {
    await pairAndSleep();
    await send("kept");
    await send("cancelled");
    const now = await fetch(`${edge.url}/api/bots/dog-1/queue/${sendId("kept")}/steer`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(now.status).toBe(200);
    expect(await now.json()).toEqual({ ok: true, queued: true, reason: HELD_UNTIL_UP, threadId: "thread-1" });
    const cancel = await fetch(`${edge.url}/api/bots/dog-1/queue/${sendId("cancelled")}`, { method: "DELETE" });
    expect(await cancel.json()).toEqual({ ok: true });
    expect(edge.held()).toEqual([sendId("kept")]);
    edge.serve();
    await edge.seen("delivered", { id: sendId("kept") }, 2_000);
    expect(home.taken.map((taken) => taken.sendId)).toEqual([sendId("kept")]);
    expect(ALREADY_ANSWERING).not.toBe(HELD_UNTIL_UP);
  });

  it("says a message was dropped when the home refuses it, and forgets that once the home takes it again", async () => {
    await pairAndSleep();
    await send("refused");
    edge.refuseNextDelivery(409);
    edge.serve();
    await edge.seen("refused", { id: sendId("refused") }, 2_000);
    expect(home.taken).toEqual([]);
    expect((await asked("refused")).dropped).toEqual([{ id: sendId("refused"), why: "refused", at: clock }]);
    expect((await send("refused")).status).toBe(200);
    expect(await asked("refused")).toEqual({ held: [], dropped: [] });
    expect(home.taken.map((taken) => taken.sendId)).toEqual([sendId("refused")]);
  });

  it("drops a held message when its hour runs out", async () => {
    await pairAndSleep();
    await send("old");
    await edge.expireHeld();
    expect(edge.held()).toEqual([]);
    expect((await asked("old")).dropped).toEqual([{ id: sendId("old"), why: "expired", at: clock }]);
    expect((await chats()).botQueuedMessages).toEqual({});
  });

  it("opens its own event stream while the home sleeps and closes it once the home serves", async () => {
    await pairAndSleep();
    const stream = await fetch(`${edge.url}/api/events`);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const reader = stream.body!.getReader();
    const hello = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(hello.slice(hello.indexOf("{")))).toMatchObject({ kind: "hello", resumed: false });
    edge.serve();
    await chats();
    expect((await reader.read()).done).toBe(true);
  });

  it("loses the answer to a send the home took, so the device asks again and the home still has it once", async () => {
    await fetch(`${edge.url}/api/bots`);
    edge.loseNextSendAnswer();
    await expect(send("lost")).rejects.toThrow();
    expect((await send("lost")).status).toBe(200);
    expect(home.taken.map((taken) => taken.sendId)).toEqual([sendId("lost")]);
  });

  it("cuts the answer to a send short after its first bytes, so the device has a status and no receipt", async () => {
    await fetch(`${edge.url}/api/bots`);
    edge.loseNextSendAnswer("mid-answer");
    const cut = await send("cut");
    expect(cut.status).toBe(202);
    await expect(cut.text()).rejects.toThrow();
    expect(edge.events.filter((event) => event.kind === "answer-lost")).toEqual([{ at: clock, kind: "answer-lost", id: sendId("cut") }]);
    expect((await send("cut")).status).toBe(200);
    expect(home.taken.map((taken) => taken.sendId)).toEqual([sendId("cut")]);
  });

  it("refuses connections while the connection is dropped and answers again afterwards", async () => {
    await chats();
    edge.dropConnection(150);
    await expect(fetch(`${edge.url}/api/bots`)).rejects.toThrow();
    await edge.seen("connection-back", {}, 2_000);
    expect((await fetch(`${edge.url}/api/bots`)).status).toBe(200);
  });

  it("saves a changed answer again only after the edge's own pause between saves", async () => {
    await chats();
    await new Promise((done) => setTimeout(done, 20));
    const first = clock;
    await send("later");
    clock += DESK_SAVE_EVERY_MS - 1;
    await chats();
    await new Promise((done) => setTimeout(done, 20));
    edge.sleep();
    const early = await fetch(`${edge.url}/api/bots`);
    expect(Date.parse(early.headers.get(SAVED_HEADER)!)).toBe(first);
    expect((await early.json()).bots[0].messages).toEqual([]);
    edge.serve();
    clock += 2;
    await chats();
    await new Promise((done) => setTimeout(done, 20));
    edge.sleep();
    const saved = await fetch(`${edge.url}/api/bots`);
    expect(Date.parse(saved.headers.get(SAVED_HEADER)!)).toBe(clock);
    expect((await saved.json()).bots[0].messages).toHaveLength(1);
  });

  it("saves the next answer at once when the pause between saves is skipped", async () => {
    await chats();
    await new Promise((done) => setTimeout(done, 20));
    await send("soon");
    clock += 1;
    edge.saveNextAnswers();
    await chats();
    await new Promise((done) => setTimeout(done, 20));
    edge.sleep();
    expect((await (await fetch(`${edge.url}/api/bots`)).json()).bots[0].messages).toHaveLength(1);
  });
});
