export const DESK_STREAM_TICK_MS = 3_000;
export const DESK_PING_EVERY_TICKS = 5;
const encoder = new TextEncoder();

export interface DeskStream {
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

export function deskEvents(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname === "/api/events";
}

export function deskFrame(stream: string, seq: number, payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(`id: ${stream}:${seq}\ndata: ${JSON.stringify({ ...payload, seq })}\n\n`);
}

export function deskHello(stream: string, seq: number): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ kind: "hello", cursor: `${stream}:${seq}`, resumed: false })}\n\n`);
}

export function deskPing(): Uint8Array {
  return encoder.encode(`: keepalive\n\ndata: ${JSON.stringify({ kind: "ping" })}\n\n`);
}

export function deskStreamResponse(readable: ReadableStream<Uint8Array>): Response {
  return new Response(readable, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}

export const deskUserId = (sendId: string) => `desk-${sendId}`;
export const deskReplyId = (sendId: string) => `desk-${sendId}-reply`;
export const deskTurnId = (sendId: string) => `desk-${sendId}`;

export function deskUserLine(input: { sendId: string; text: string; at: number; parentId: string | null }) {
  return {
    id: deskUserId(input.sendId),
    at: input.at,
    parentId: input.parentId,
    role: "user" as const,
    kind: "text" as const,
    text: input.text,
    sendId: input.sendId,
    queueId: input.sendId,
  };
}

export function deskReplyLine(input: { sendId: string; text: string; at: number }) {
  return {
    id: deskReplyId(input.sendId),
    at: input.at,
    parentId: deskUserId(input.sendId),
    role: "bot" as const,
    kind: "text" as const,
    text: input.text,
    turnId: deskTurnId(input.sendId),
    turnTerminal: true,
  };
}

export function deskRuntime(type: string, threadId: string, sendId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "runtime",
    event: {
      type,
      threadId,
      turnId: deskTurnId(sendId),
      eventId: crypto.randomUUID(),
      provider: "laterdogAi",
      createdAt: new Date().toISOString(),
      ...extra,
    },
  };
}
