import type { ServerResponse } from "node:http";

export function requestGone(res: ServerResponse): AbortSignal {
  const left = new AbortController();
  if (res.destroyed || res.socket?.destroyed) left.abort();
  else res.once("close", () => { if (!res.writableEnded) left.abort(); });
  return left.signal;
}
