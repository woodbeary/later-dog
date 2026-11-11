import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  DESK_SAVE_EVERY_MS,
  answerHeldQueueAsk,
  deliveryOutcome,
  deskAnswerWithQueue,
  deskKey,
  deskKind,
  deskLimit,
  deskSend,
  heldQueueAsk,
  heldSendsAnswer,
  heldSendsAsk,
  queuedReceipt,
  queuedSend,
  refusedSend,
  savable,
  saveAnswer,
  savedAnswer,
  sendIdOf,
  withDropped,
  withQueued,
  withoutDropped,
  type DeskBucket,
  type DeskKind,
  type DeskObject,
  type DroppedSend,
  type QueuedSend,
} from "../../deploy/laterdog/home/src/desk.ts";
import {
  DESK_PING_EVERY_TICKS,
  DESK_STREAM_TICK_MS,
  deskEvents,
  deskHello,
  deskPing,
  deskStreamResponse,
  type DeskStream,
} from "../../deploy/laterdog/home/src/desk-stream.ts";
import { hex, sha256 } from "../../deploy/laterdog/home/src/encoding.ts";
import { isBackground, wakeResponse } from "../../deploy/laterdog/home/src/waking.ts";

export const FIXTURE_HOME = "fixture-home";
export const FIXTURE_DEVICE = "fixture-device";
export const DELIVERY_RETRY_MS = 5_000;
export const HELD_GIVE_UP_MS = 60 * 60 * 1000;

export type HomeState = "stopped" | "starting" | "serving";
export type AnswerLoss = "before any byte" | "mid-answer";

export type EdgeEventKind =
  | "asleep"
  | "waking"
  | "told-waking"
  | "serving"
  | "held"
  | "held-again"
  | "delivered"
  | "refused"
  | "delivery-retry"
  | "expired"
  | "send-now"
  | "cancelled"
  | "sent"
  | "answer-lost"
  | "desk-stream-open"
  | "desk-stream-closed"
  | "home-stream-open"
  | "home-stream-closed"
  | "connection-dropped"
  | "connection-back";

export interface EdgeEvent {
  at: number;
  kind: EdgeEventKind;
  id?: string;
  status?: number;
  gotAt?: number;
}

export interface FixtureEdgeOptions {
  home: string;
  now?: () => number;
  deliveryRetryMs?: number;
}

export interface FixtureEdge {
  readonly url: string;
  readonly events: readonly EdgeEvent[];
  state(): HomeState;
  held(): string[];
  dropped(): DroppedSend[];
  sleep(): void;
  wakeIn(ms: number): void;
  serve(): void;
  refuseNextDelivery(status?: number): void;
  loseNextSendAnswer(how?: AnswerLoss): void;
  saveNextAnswers(): void;
  expireHeld(): Promise<void>;
  dropConnection(ms: number): void;
  seen(kind: EdgeEventKind, match?: { id?: string; after?: number }, timeoutMs?: number): Promise<EdgeEvent>;
  close(): Promise<void>;
}

interface Stored {
  bytes: ArrayBuffer;
  httpMetadata: { contentType: string };
  customMetadata: Record<string, string>;
}

export function memoryBucket(): DeskBucket {
  const objects = new Map<string, Stored>();
  return {
    async get(key): Promise<DeskObject | null> {
      const stored = objects.get(key);
      return stored ? { body: new Response(stored.bytes.slice(0)).body, httpMetadata: stored.httpMetadata, customMetadata: stored.customMetadata } : null;
    },
    async put(key, value, options) {
      objects.set(key, { bytes: value, ...options });
    },
    async delete(keys) {
      for (const key of [keys].flat()) objects.delete(key);
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

const HOP_HEADERS = ["host", "connection", "content-length", "accept-encoding", "keep-alive", "transfer-encoding", "upgrade"];
const ENCODED_HEADERS = ["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"];

async function requestFrom(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const entry of [value].flat()) headers.append(name, entry);
  }
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
  return new Request(new URL(req.url ?? "/", origin), { method, headers, body });
}

async function answer(res: ServerResponse, response: Response): Promise<void> {
  const cookies = response.headers.getSetCookie();
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.once("close", () => void reader.cancel().catch(() => undefined));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise<void>((flushed) => res.write(value, () => flushed()));
    }
  } catch {
    res.destroy();
    return;
  }
  res.end();
}

function answerCutShort(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
    },
    pull(controller) {
      controller.error(new Error("the fixture edge cut this answer short"));
    },
  });
  return new Response(body, { status: 202, headers: { "content-type": "application/json", "content-length": "64" } });
}

export async function startFixtureEdge(options: FixtureEdgeOptions): Promise<FixtureEdge> {
  const home = new URL(options.home).origin;
  const now = options.now ?? Date.now;
  const deliveryRetryMs = options.deliveryRetryMs ?? DELIVERY_RETRY_MS;
  const bucket = memoryBucket();
  const events: EdgeEvent[] = [];
  const watchers = new Set<() => void>();
  const sockets = new Set<Socket>();
  const deskStreams = new Set<DeskStream>();
  const homeStreams = new Set<AbortController>();
  const lastSaved = new Map<string, { digest: string; at: number }>();
  const background = new Set<Promise<unknown>>();
  const streamName = `desk-${randomUUID().slice(0, 8)}`;
  let state: HomeState = "serving";
  let outbox: QueuedSend[] = [];
  let dropped: DroppedSend[] = [];
  let delivering: Promise<void> | null = null;
  let deviceKnown = false;
  let scriptedRefusal: number | null = null;
  let losesNextAnswer: AnswerLoss | null = null;
  let refusingConnections = false;
  let streamTicks = 0;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let dropTimer: ReturnType<typeof setTimeout> | null = null;
  let streamTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const note = (kind: EdgeEventKind, extra: { id?: string; status?: number; gotAt?: number } = {}) => {
    events.push({ at: now(), kind, ...extra });
    for (const watcher of [...watchers]) watcher();
  };
  const waitUntil = (work: Promise<unknown>) => {
    const tracked = work.catch(() => undefined).finally(() => background.delete(tracked));
    background.add(tracked);
  };

  const forgetDropped = (id: string) => {
    dropped = withoutDropped(dropped, [id]);
  };

  const toHome = (request: Request): Headers => {
    const headers = new Headers(request.headers);
    for (const name of HOP_HEADERS) headers.delete(name);
    if (headers.has("origin")) headers.set("origin", home);
    if (headers.has("referer")) headers.set("referer", `${home}/`);
    return headers;
  };

  const forward = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const stream = deskEvents(request);
    const abort = new AbortController();
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.clone().arrayBuffer();
    let reply: Response;
    try {
      reply = await fetch(`${home}${url.pathname}${url.search}`, { method: request.method, headers: toHome(request), body, redirect: "manual", signal: abort.signal });
    } catch {
      return Response.json({ error: "the fixture home did not answer" }, { status: 502 });
    }
    const headers = new Headers(reply.headers);
    for (const name of ENCODED_HEADERS) headers.delete(name);
    if (!stream || !reply.body) return new Response(reply.body, { status: reply.status, headers });
    homeStreams.add(abort);
    note("home-stream-open");
    const reader = reply.body.getReader();
    const piped = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (!done) return controller.enqueue(value);
        } catch {}
        homeStreams.delete(abort);
        note("home-stream-closed");
        controller.close();
      },
      cancel() {
        homeStreams.delete(abort);
        abort.abort();
        note("home-stream-closed");
      },
    });
    return new Response(piped, { status: reply.status, headers });
  };

  const dropDeskStream = (stream: DeskStream) => {
    if (!deskStreams.delete(stream)) return;
    stream.writer.close().catch(() => undefined);
    note("desk-stream-closed");
    if (!deskStreams.size && streamTimer !== null) {
      clearInterval(streamTimer);
      streamTimer = null;
    }
  };
  const closeDeskStreams = () => {
    for (const stream of [...deskStreams]) dropDeskStream(stream);
  };
  const write = (stream: DeskStream, bytes: Uint8Array) => {
    stream.writer.write(bytes).catch(() => dropDeskStream(stream));
  };
  const tendDeskStreams = () => {
    streamTicks += 1;
    if (streamTicks % DESK_PING_EVERY_TICKS === 0) for (const stream of deskStreams) write(stream, deskPing());
    if (state === "serving") closeDeskStreams();
  };
  const openDeskStream = (): Response => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const stream: DeskStream = { writer: writable.getWriter() };
    deskStreams.add(stream);
    write(stream, deskHello(streamName, 0));
    streamTimer ??= setInterval(tendDeskStreams, DESK_STREAM_TICK_MS);
    note("desk-stream-open");
    return deskStreamResponse(readable);
  };

  const deliver = (): Promise<void> => {
    delivering ??= (async () => {
      while (outbox.length) {
        const queued = outbox[0]!;
        const scripted = scriptedRefusal;
        scriptedRefusal = null;
        const status = scripted ?? await fetch(`${home}${queued.path}`, { method: "POST", headers: queued.headers, body: queued.body }).then(
          async (reply) => {
            await reply.arrayBuffer();
            return reply.status;
          },
          () => null,
        );
        const outcome = deliveryOutcome(status);
        if (outcome === "retry") {
          note("delivery-retry", { id: queued.id, ...(status === null ? {} : { status }) });
          break;
        }
        if (outcome === "refused") dropped = withDropped(dropped, [queued], "refused", now());
        else forgetDropped(queued.id);
        outbox = outbox.filter((held) => held.id !== queued.id);
        note(outcome, { id: queued.id, ...(status === null ? {} : { status }) });
      }
    })().catch(() => undefined).finally(() => {
      delivering = null;
    });
    return delivering;
  };

  const armDelivery = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => waitUntil(deliverQueued(now())), deliveryRetryMs);
  };

  const deliverQueued = async (at: number): Promise<void> => {
    if (closed || !outbox.length) return;
    await delivering;
    const kept = outbox.filter((queued) => at - queued.at < HELD_GIVE_UP_MS);
    if (kept.length !== outbox.length) {
      const lost = outbox.filter((queued) => !kept.includes(queued));
      dropped = withDropped(dropped, lost, "expired", now());
      outbox = kept;
      for (const queued of lost) note("expired", { id: queued.id });
    }
    if (!outbox.length) return;
    if (state === "serving") await deliver();
    if (outbox.length) armDelivery();
  };

  const answerHeld = async (request: Request): Promise<Response | null> => {
    const ids = deviceKnown ? heldSendsAsk(request) : null;
    if (ids) {
      await delivering;
      return heldSendsAnswer(outbox, dropped, ids);
    }
    if (!outbox.length) return null;
    const asked = deviceKnown ? heldQueueAsk(request) : null;
    if (asked) await delivering;
    const answered = asked ? answerHeldQueueAsk(outbox, asked) : null;
    if (!asked || !answered) return null;
    if (answered.outbox.length !== outbox.length) {
      outbox = answered.outbox;
      note("cancelled", { id: asked.id });
    } else {
      note("send-now", { id: asked.id, status: answered.response.status });
    }
    return answered.response;
  };

  const answerAsleep = async (request: Request, gotAt: number): Promise<Response | null> => {
    const held = await answerHeld(request);
    if (held) return held;
    if (deskSend(request)) {
      if (!deviceKnown) return null;
      const queued = await queuedSend(request.clone(), now());
      if (queued === "refused") return refusedSend();
      if (queued && outbox.some((earlier) => earlier.id === queued.id)) {
        note("held-again", { id: queued.id, gotAt });
        return queuedReceipt(queued);
      }
      const next = queued ? withQueued(outbox, queued) : null;
      if (!queued || !next) return null;
      outbox = next;
      forgetDropped(queued.id);
      armDelivery();
      note("held", { id: queued.id, gotAt });
      return queuedReceipt(queued);
    }
    const kind = deskKind(request);
    const scope = kind === "shell" ? "ui" : kind && deviceKnown ? FIXTURE_DEVICE : null;
    if (!kind || !scope) return null;
    const saved = await savedAnswer(bucket, await deskKey(FIXTURE_HOME, scope, request.url), now());
    if (!saved || !outbox.length || new URL(request.url).pathname !== "/api/bots") return saved;
    return deskAnswerWithQueue(saved, outbox);
  };

  const keepAnswer = (kind: Exclude<DeskKind, null>, request: Request, response: Response): Response => {
    if (!savable(kind, response)) return response;
    if (kind === "read") deviceKnown = true;
    const scope = kind === "shell" ? "ui" : FIXTURE_DEVICE;
    const copy = response.clone();
    waitUntil((async () => {
      const where = await deskKey(FIXTURE_HOME, scope, request.url);
      const at = now();
      const last = lastSaved.get(where);
      if (last && at - last.at < DESK_SAVE_EVERY_MS) return;
      const bytes = new Uint8Array(await copy.arrayBuffer());
      const digest = hex(await sha256(bytes));
      if (last?.digest === digest) {
        lastSaved.set(where, { digest, at });
        return;
      }
      const stored = await saveAnswer(bucket, where, new Response(bytes, { headers: copy.headers }), deskLimit(kind, request), at);
      if (stored) lastSaved.set(where, { digest: stored, at });
    })());
    return response;
  };

  const sentAgain = async (request: Request): Promise<string | null> => {
    if (!dropped.length || !deskSend(request)) return null;
    const sendId = sendIdOf(await request.clone().text().catch(() => ""));
    return sendId && dropped.some((send) => send.id === sendId) ? sendId : null;
  };

  const handle = async (request: Request, gotAt: number): Promise<Response | null> => {
    if (state === "serving") {
      closeDeskStreams();
      if (outbox.length) await deliver();
      const held = await answerHeld(request);
      if (held) return held;
      const kind = deskKind(request);
      const again = await sentAgain(request);
      const send = deskSend(request) ? sendIdOf(await request.clone().text().catch(() => "")) : null;
      const loses = deskSend(request) ? losesNextAnswer : null;
      if (loses) losesNextAnswer = null;
      const response = await forward(request);
      if (again && response.ok) forgetDropped(again);
      if (deskSend(request)) note("sent", { ...(send ? { id: send } : {}), status: response.status, gotAt });
      if (loses) {
        await response.arrayBuffer().catch(() => undefined);
        note("answer-lost", send ? { id: send } : {});
        return loses === "mid-answer" ? answerCutShort() : null;
      }
      return kind ? keepAnswer(kind, request, response) : response;
    }
    const person = !isBackground(request);
    if (deskEvents(request) && deviceKnown && person) return openDeskStream();
    const saved = await answerAsleep(request, gotAt);
    if (saved) return saved;
    const wake = person || state === "starting" ? "waking" : "asleep";
    if (wake === "waking") note("told-waking", { status: 503 });
    return wakeResponse(request, wake);
  };

  const server = createServer((req, res) => {
    if (refusingConnections) {
      req.socket.destroy();
      return;
    }
    const gotAt = now();
    void (async () => {
      const response = await handle(await requestFrom(req, url), gotAt);
      if (response === null || refusingConnections) {
        req.socket.destroy();
        return;
      }
      await answer(res, response);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "the fixture edge failed" }));
    });
  });
  server.on("connection", (socket) => {
    if (refusingConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const cutStreams = () => {
    closeDeskStreams();
    for (const stream of [...homeStreams]) stream.abort();
  };

  return {
    url,
    events,
    state: () => state,
    held: () => outbox.map((queued) => queued.id),
    dropped: () => [...dropped],
    sleep() {
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = null;
      state = "stopped";
      for (const stream of [...homeStreams]) stream.abort();
      note("asleep");
    },
    wakeIn(ms) {
      if (wakeTimer) clearTimeout(wakeTimer);
      state = "starting";
      note("waking");
      wakeTimer = setTimeout(() => {
        wakeTimer = null;
        state = "serving";
        note("serving");
      }, ms);
    },
    serve() {
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = null;
      state = "serving";
      note("serving");
    },
    refuseNextDelivery(status = 409) {
      scriptedRefusal = status;
    },
    loseNextSendAnswer(how = "before any byte") {
      losesNextAnswer = how;
    },
    saveNextAnswers() {
      lastSaved.clear();
    },
    expireHeld: () => deliverQueued(now() + HELD_GIVE_UP_MS),
    dropConnection(ms) {
      if (dropTimer) clearTimeout(dropTimer);
      refusingConnections = true;
      cutStreams();
      for (const socket of [...sockets]) socket.destroy();
      note("connection-dropped");
      dropTimer = setTimeout(() => {
        dropTimer = null;
        refusingConnections = false;
        note("connection-back");
      }, ms);
    },
    seen(kind, match = {}, timeoutMs = 30_000) {
      const find = () => events.find((event) => event.kind === kind && (match.id === undefined || event.id === match.id) && (match.after === undefined || event.at >= match.after));
      return new Promise<EdgeEvent>((found, missed) => {
        const first = find();
        if (first) return found(first);
        const watcher = () => {
          const event = find();
          if (!event) return;
          clearTimeout(timer);
          watchers.delete(watcher);
          found(event);
        };
        const timer = setTimeout(() => {
          watchers.delete(watcher);
          missed(new Error(`the fixture edge never saw "${kind}"${match.id ? ` for ${match.id}` : ""} within ${timeoutMs} ms`));
        }, timeoutMs);
        watchers.add(watcher);
      });
    },
    async close() {
      closed = true;
      for (const timer of [wakeTimer, retryTimer, dropTimer]) if (timer) clearTimeout(timer);
      if (streamTimer !== null) clearInterval(streamTimer);
      cutStreams();
      await Promise.all([...background]);
      for (const socket of [...sockets]) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
