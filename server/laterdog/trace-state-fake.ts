import type { Readable } from "node:stream";

export async function slurp(stream: Readable | null): Promise<Buffer | null> {
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export interface FakeStateRequest { method: string; path: string; headers: Record<string, string>; bytes: number }

export class FakeTraceState {
  readonly objects = new Map<string, { body: Buffer; retainDays: number; truncated: boolean }>();
  readonly requests: FakeStateRequest[] = [];
  failPuts = 0;
  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    const body = init.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    this.requests.push({ method, path: url.pathname, headers, bytes: body.length });
    const key = url.pathname.replace(/^\/+/, "");
    if (method === "PUT") {
      if (this.failPuts > 0) { this.failPuts -= 1; return new Response("boom", { status: 500 }); }
      const retainDays = Number(headers["x-laterdog-retain-days"] ?? 30);
      this.objects.set(key, { body, retainDays, truncated: headers["x-laterdog-truncated"] === "1" });
      return Response.json({ key, bytes: body.length, expiresAt: new Date(Date.now() + retainDays * 86_400_000).toISOString() }, { status: 201 });
    }
    if (method === "GET") {
      const found = this.objects.get(key);
      return found ? new Response(new Uint8Array(found.body), { status: 200 }) : new Response("Not found", { status: 404 });
    }
    return new Response("no", { status: 405 });
  }) as unknown as typeof fetch;
}
