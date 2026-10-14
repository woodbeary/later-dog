import type { IncomingMessage, ServerResponse } from "node:http";

const jsonHooks = new WeakMap<ServerResponse, (body: unknown) => unknown>();
const parsedBodies = new WeakMap<IncomingMessage, unknown>();
const bodyGuards = new WeakMap<IncomingMessage, (body: unknown) => string | null>();

export function guardBody(req: IncomingMessage, guard: (body: unknown) => string | null): void {
  bodyGuards.set(req, guard);
}

export function onJsonBody(res: ServerResponse, hook: (body: unknown) => unknown): void {
  const previous = jsonHooks.get(res);
  jsonHooks.set(res, previous ? (body) => hook(previous(body)) : hook);
}

export function parsedBodyOf(req: IncomingMessage): unknown {
  return parsedBodies.get(req);
}

export function json(res: ServerResponse, status: number, body: unknown) {
  const hook = jsonHooks.get(res);
  const data = JSON.stringify(hook ? hook(body) : body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

export function readBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const fail = (status: number, msg: string) => {
      if (done) return;
      done = true;
      const err = Object.assign(new Error(msg), { status });
      reject(err);
    };
    req.on("data", (c) => {
      if (done) return;
      bytes += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (bytes > limit) {
        return fail(413, "body too large");
      }
      chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    });
    req.on("end", () => {
      if (done) return;
      const data = Buffer.concat(chunks).toString("utf8");
      let body: any;
      try {
        body = data ? JSON.parse(data) : {};
      } catch {
        return fail(400, "invalid JSON body");
      }
      const refusal = bodyGuards.get(req)?.(body);
      if (refusal) return fail(403, refusal);
      done = true;
      parsedBodies.set(req, body);
      resolve(body);
    });
    req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
  });
}
