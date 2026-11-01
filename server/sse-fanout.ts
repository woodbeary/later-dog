import type { IncomingMessage, ServerResponse } from "node:http";

export interface SseFanoutClient {
  res: {
    write(chunk: string): boolean;
    end(): void;
    destroy(): void;
    writableLength: number;
    writableEnded: boolean;
    destroyed: boolean;
    once(event: "drain", listener: () => void): unknown;
  };
  backpressured: boolean;
}

export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type SseFanoutOutcome = "sent" | "dropped" | "disconnected";

function writable(client: SseFanoutClient): boolean {
  return !client.res.writableEnded && !client.res.destroyed;
}

function cutOff(client: SseFanoutClient): void {
  try {
    client.res.destroy();
  } catch {}
}

function closeResponse(client: SseFanoutClient): void {
  const { res } = client;
  if (res.destroyed) return;
  if (res.writableEnded || client.backpressured || res.writableLength > SSE_MAX_BUFFERED_BYTES) {
    cutOff(client);
    return;
  }
  try {
    res.end();
  } catch {
    cutOff(client);
  }
}

export function deliverSseFrame(client: SseFanoutClient, kind: string, frame: string): SseFanoutOutcome {
  if (!writable(client) || client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
    closeResponse(client);
    return "disconnected";
  }
  if (client.backpressured && kind === "screen") return "dropped";
  try {
    if (!client.res.write(frame) && !client.backpressured) {
      client.backpressured = true;
      client.res.once("drain", () => {
        client.backpressured = false;
      });
    }
    return "sent";
  } catch {
    cutOff(client);
    return "disconnected";
  }
}

export interface SseKeepalive {
  heartbeatMs: number;
  live: () => boolean;
  onClose: () => void;
}

const SSE_PING = `: keepalive\n\ndata: ${JSON.stringify({ kind: "ping" })}\n\n`;

export function keepSseAlive(req: IncomingMessage, client: { res: ServerResponse; backpressured: boolean }, options: SseKeepalive): () => void {
  const { res } = client;
  let beat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (beat === undefined) return;
    clearInterval(beat);
    beat = undefined;
    options.onClose();
  };
  const close = () => {
    stop();
    closeResponse(client);
  };
  beat = setInterval(() => {
    if (!options.live() || deliverSseFrame(client, "ping", SSE_PING) === "disconnected") close();
  }, options.heartbeatMs);
  req.once("close", stop);
  res.once("close", stop);
  res.once("finish", stop);
  res.on("error", close);
  if (!writable(client)) close();
  return close;
}
