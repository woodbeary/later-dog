import { MAX_INPUT_BYTES, MAX_PENDING, failure, harnessMcpRequest, type HarnessMcpKind, type RpcId } from "../harness-mcp-request.ts";

export interface HarnessMcpSession {
  line(text: string): void;
  close(): void;
}

export function harnessMcpSession(env: Record<string, string | undefined>, kind: HarnessMcpKind, send: (msg: unknown) => void, request = harnessMcpRequest): HarnessMcpSession {
  const connection = { url: env.LATERDOG_HARNESS_URL ?? "", token: env.LATERDOG_MCP_TOKEN ?? "", kind };
  let pending = 0;
  let closed = false;
  const reply = (message: unknown) => { if (!closed && message !== undefined) send(message); };
  return {
    line(text) {
      if (closed || !text.trim()) return;
      if (Buffer.byteLength(text) > MAX_INPUT_BYTES) { reply(failure(null, null, `${kind} request exceeded the size limit.`, -32600)); return; }
      let frame: unknown;
      try { frame = JSON.parse(text); }
      catch { reply(failure(null, null, "Parse error.", -32700)); return; }
      if (pending >= MAX_PENDING) {
        const asked = frame as { id?: RpcId; method?: unknown } | null;
        if (asked && Object.hasOwn(asked, "id")) reply(failure(asked.id ?? null, asked.method, `Too many pending ${kind} requests.`));
        return;
      }
      pending++;
      void request(frame, connection).then(reply, () => {}).finally(() => { pending--; });
    },
    close() { closed = true; },
  };
}
