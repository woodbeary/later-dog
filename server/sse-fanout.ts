
export interface SseFanoutClient {
  res: {
    write(chunk: string): boolean;
    end(): void;
    writableLength: number;
    once(event: "drain", listener: () => void): unknown;
  };
  backpressured: boolean;
}

export const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type SseFanoutOutcome = "sent" | "dropped" | "disconnected";

export function deliverSseFrame(client: SseFanoutClient, kind: string, frame: string): SseFanoutOutcome {
  if (client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
    try {
      client.res.end();
    } catch {}
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
    return "disconnected";
  }
}
