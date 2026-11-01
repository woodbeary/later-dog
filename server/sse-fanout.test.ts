import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deliverSseFrame, keepSseAlive, SSE_MAX_BUFFERED_BYTES, type SseFanoutClient } from "./sse-fanout.ts";

type TestClient = SseFanoutClient & { drains: (() => void)[] };

function fakeClient(resOverrides: Partial<SseFanoutClient["res"]> = {}): TestClient {
  const drains: (() => void)[] = [];
  return {
    backpressured: false,
    drains,
    res: {
      writableLength: 0,
      writableEnded: false,
      destroyed: false,
      write: () => true,
      end: () => {},
      destroy: () => {},
      once: (_event: "drain", listener: () => void) => drains.push(listener),
      ...resOverrides,
    },
  };
}

describe("deliverSseFrame", () => {
  it("sends normally while write() returns true", () => {
    const client = fakeClient();
    expect(deliverSseFrame(client, "message", "frame-a")).toBe("sent");
    expect(client.backpressured).toBe(false);
  });

  it("marks the client backpressured when write() returns false, without dropping that frame", () => {
    const client = fakeClient({ write: () => false });
    expect(deliverSseFrame(client, "message", "frame-a")).toBe("sent");
    expect(client.backpressured).toBe(true);
  });

  it("drops a replaceable screen frame once backpressured, but never drops a durable event", () => {
    const written: string[] = [];
    const client = fakeClient({
      write: (chunk: string) => {
        written.push(chunk);
        return false;
      },
    });

    expect(deliverSseFrame(client, "screen", "screen-1")).toBe("sent");
    expect(client.backpressured).toBe(true);

    expect(deliverSseFrame(client, "screen", "screen-2")).toBe("dropped");

    expect(deliverSseFrame(client, "message", "message-1")).toBe("sent");

    expect(written).toEqual(["screen-1", "message-1"]);
  });

  it("cuts off a client once buffered bytes exceed the bound, even for a durable event", () => {
    let destroyed = false;
    const client = fakeClient({
      writableLength: SSE_MAX_BUFFERED_BYTES + 1,
      destroy: () => {
        destroyed = true;
      },
    });
    expect(deliverSseFrame(client, "message", "message-1")).toBe("disconnected");
    expect(destroyed).toBe(true);
  });

  it.each([
    ["ended", { writableEnded: true }],
    ["been destroyed", { destroyed: true }],
  ])("never writes to a response that has already %s", (_state, state) => {
    const written: string[] = [];
    const client = fakeClient({
      ...state,
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    });
    expect(deliverSseFrame(client, "message", "message-1")).toBe("disconnected");
    expect(written).toEqual([]);
  });

  it("resumes screen frames once the socket drains", () => {
    let full = true;
    const client = fakeClient({ write: () => !full });

    expect(deliverSseFrame(client, "screen", "screen-1")).toBe("sent");
    expect(client.backpressured).toBe(true);
    expect(deliverSseFrame(client, "screen", "screen-2")).toBe("dropped");
    expect(client.drains).toHaveLength(1);

    full = false;
    for (const drain of client.drains) drain();

    expect(client.backpressured).toBe(false);
    expect(deliverSseFrame(client, "screen", "screen-3")).toBe("sent");
  });

  it("queues one drain listener per backpressure episode, not per frame", () => {
    const client = fakeClient({ write: () => false });

    deliverSseFrame(client, "message", "message-1");
    deliverSseFrame(client, "message", "message-2");
    deliverSseFrame(client, "message", "message-3");

    expect(client.backpressured).toBe(true);
    expect(client.drains).toHaveLength(1);
  });

  it("treats a throwing write() as a dead connection", () => {
    const client = fakeClient({
      write: () => {
        throw new Error("socket hang up");
      },
    });
    expect(deliverSseFrame(client, "message", "message-1")).toBe("disconnected");
  });
});

const BEAT_MS = 1_000;
const teardowns: (() => Promise<void>)[] = [];

async function openStream(): Promise<{ req: IncomingMessage; res: ServerResponse }> {
  const server = createServer();
  const request = new Promise<{ req: IncomingMessage; res: ServerResponse }>((resolve) => {
    server.once("request", (req: IncomingMessage, res: ServerResponse) => resolve({ req, res }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const reader = connect((server.address() as AddressInfo).port, "127.0.0.1");
  reader.on("error", () => {});
  reader.pause();
  reader.write("GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  teardowns.push(async () => {
    reader.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const stream = await request;
  stream.res.writeHead(200, { "content-type": "text/event-stream" });
  return stream;
}

function stall(res: ServerResponse, bytes: number): void {
  const chunk = `data: ${"x".repeat(64 * 1024)}\n\n`;
  for (let i = 0; i < 2_000 && res.writableLength <= bytes; i++) res.write(chunk);
  expect(res.writableLength).toBeGreaterThan(bytes);
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("keepSseAlive", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const teardown of teardowns.splice(0)) await teardown();
  });

  it("pings the client on every beat while the stream is open", async () => {
    const { req, res } = await openStream();
    const write = vi.spyOn(res, "write");
    keepSseAlive(req, { res, backpressured: false }, { heartbeatMs: BEAT_MS, live: () => true, onClose: () => {} });
    vi.advanceTimersByTime(2 * BEAT_MS);
    expect(write).toHaveBeenCalledTimes(2);
    expect(String(write.mock.calls[0]?.[0])).toContain(`"kind":"ping"`);
  });

  it("stops beating, without writing, once another path ends the stream of a client that stopped reading", async () => {
    const { req, res } = await openStream();
    const forget = vi.fn();
    keepSseAlive(req, { res, backpressured: false }, { heartbeatMs: BEAT_MS, live: () => true, onClose: forget });
    stall(res, 64 * 1024);
    res.end();
    const write = vi.spyOn(res, "write");
    vi.advanceTimersByTime(4 * BEAT_MS);
    await settle();
    expect(write).not.toHaveBeenCalled();
    expect(forget).toHaveBeenCalledTimes(1);
    expect(res.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops beating, without writing, once fanout cuts off a client whose backlog passed the bound", async () => {
    const { req, res } = await openStream();
    const client = { res, backpressured: false };
    const forget = vi.fn();
    keepSseAlive(req, client, { heartbeatMs: BEAT_MS, live: () => true, onClose: forget });
    stall(res, SSE_MAX_BUFFERED_BYTES);
    expect(deliverSseFrame(client, "message", "data: {}\n\n")).toBe("disconnected");
    const write = vi.spyOn(res, "write");
    vi.advanceTimersByTime(4 * BEAT_MS);
    await settle();
    expect(write).not.toHaveBeenCalled();
    expect(res.destroyed).toBe(true);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the stream and forgets the client as soon as its session is no longer live", async () => {
    const { req, res } = await openStream();
    let live = true;
    const forget = vi.fn();
    keepSseAlive(req, { res, backpressured: false }, { heartbeatMs: BEAT_MS, live: () => live, onClose: forget });
    live = false;
    vi.advanceTimersByTime(BEAT_MS);
    expect(res.writableEnded).toBe(true);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closing the stream stops the beat and forgets the client, then ends the response", async () => {
    const { req, res } = await openStream();
    const forget = vi.fn();
    const close = keepSseAlive(req, { res, backpressured: false }, { heartbeatMs: BEAT_MS, live: () => true, onClose: forget });
    close();
    const write = vi.spyOn(res, "write");
    vi.advanceTimersByTime(4 * BEAT_MS);
    await settle();
    expect(res.writableEnded).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(forget).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cuts off, rather than ends, a stream whose client stopped reading", async () => {
    const { req, res } = await openStream();
    const client = { res, backpressured: false };
    const close = keepSseAlive(req, client, { heartbeatMs: BEAT_MS, live: () => true, onClose: () => {} });
    stall(res, 64 * 1024);
    deliverSseFrame(client, "message", "data: {}\n\n");
    expect(client.backpressured).toBe(true);
    close();
    expect(res.destroyed).toBe(true);
  });

  it("closes the stream when a late write fails, instead of leaving the error unhandled", async () => {
    const { req, res } = await openStream();
    const forget = vi.fn();
    keepSseAlive(req, { res, backpressured: false }, { heartbeatMs: BEAT_MS, live: () => true, onClose: forget });
    expect(res.listenerCount("error")).toBeGreaterThan(0);
    stall(res, 64 * 1024);
    res.end();
    res.write("data: late\n\n");
    await settle();
    expect(forget).toHaveBeenCalledTimes(1);
    expect(res.destroyed).toBe(true);
  });
});
