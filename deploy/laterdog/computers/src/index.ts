// later.dog cloud computers: every dog gets its own Linux desktop on Cloudflare Containers.
//
// This Worker is the front door. /v1/... is the API later.dog's server calls (bearer key, server to server only);
// /desktop/<id>/<token>/... is the signed viewer link a person opens to watch a computer and take it over. Each computer is
// a DogComputer Durable Object addressed by its id (src/computer.ts); one ComputerRegistry Durable Object lists them
// (src/registry.ts). README.md describes the API, the costs and the idle policy.

import { refuseApiRequest } from "./auth";
import type { DogComputer, Result } from "./computer";
import { TooLarge, apiError, json, readLimited } from "./http";
import { maxComputers } from "./idle";
import { FILE_MAX_BYTES, JSON_MAX_BYTES, parseCreate, parseExec, parseIdempotencyKey, parsePath, parseRename } from "./inputs";
import type { ComputerRegistry } from "./registry";
import { type ComputerOp, route } from "./routes";

export { DogComputer } from "./computer";
export { ComputerRegistry } from "./registry";

// Secrets are set with `wrangler secret put` (README.md), so the generated Env type does not know them.
declare global {
  interface Env {
    COMPUTERS_KEY_SHA256?: string;
    DESKTOP_SIGNING_KEY?: string;
  }
}

function computer(env: Env, id: string): DurableObjectStub<DogComputer> {
  return env.COMPUTER.get(env.COMPUTER.idFromName(id));
}

function registry(env: Env): DurableObjectStub<ComputerRegistry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

function answer<T>(result: Result<T>, render: (value: T) => Response): Response {
  return result.ok ? render(result.value) : apiError(result.refusal);
}

type Body = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJson(request: Request): Promise<Body> {
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(request.body, JSON_MAX_BYTES);
  } catch (error) {
    if (error instanceof TooLarge) return { ok: false, response: apiError({ status: 413, code: "too_large", message: error.message }) };
    throw error;
  }
  if (bytes.byteLength === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: apiError({ status: 400, code: "invalid_json", message: "The body is not valid JSON." }) };
  }
}

async function listComputers(env: Env): Promise<Response> {
  return json({ computers: await registry(env).list() });
}

async function createComputer(request: Request, env: Env): Promise<Response> {
  const key = parseIdempotencyKey(request.headers.get("idempotency-key"));
  if (!key.ok) return apiError(key.refusal);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const input = parseCreate(body.value);
  if (!input.ok) return apiError(input.refusal);
  const reservation = await registry(env).reserve({ ...input.value, ...(key.value === undefined ? {} : { idempotencyKey: key.value }), max: maxComputers(env) });
  if (!reservation.ok) return apiError(reservation.refusal);
  const stub = computer(env, reservation.id);
  let result: Result<unknown>;
  try {
    result = await stub.init({ id: reservation.id, name: reservation.name, size: reservation.size });
  } catch (error) {
    result = { ok: false, refusal: { status: 502, code: "start_failed", message: error instanceof Error ? error.message : String(error) } };
  }
  if (!result.ok) {
    // A computer that never started is not kept around (or counted against the cap).
    if (!reservation.replayed) {
      await stub.remove().catch(() => undefined);
      await registry(env).remove(reservation.id);
    }
    return apiError(result.refusal);
  }
  return json({ computer: result.value }, 201, reservation.replayed ? { "idempotent-replayed": "true" } : {});
}

async function computerRequest(op: ComputerOp, id: string, request: Request, env: Env, url: URL): Promise<Response> {
  const stub = computer(env, id);
  switch (op) {
    case "get":
      return answer(await stub.describe(), (value) => json({ computer: value }));
    case "rename": {
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const input = parseRename(body.value);
      if (!input.ok) return apiError(input.refusal);
      return answer(await stub.rename(input.value.name), (value) => json({ computer: value }));
    }
    case "delete": {
      const result = await stub.remove();
      const listed = await registry(env).remove(id);
      // Deleting is idempotent while the registry still lists the computer (an earlier delete stopped halfway).
      if (!result.ok && !(result.refusal.status === 404 && listed)) return apiError(result.refusal);
      return json({ deleted: true });
    }
    case "wake":
      return answer(await stub.wake(), (value) => json({ computer: value }));
    case "sleep":
      return answer(await stub.sleep("request"), (value) => json({ computer: value }));
    case "exec": {
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const input = parseExec(body.value);
      if (!input.ok) return apiError(input.refusal);
      return answer(await stub.exec(input.value), (value) => json(value));
    }
    case "readFile": {
      const path = parsePath(url.searchParams.get("path"));
      if (!path.ok) return apiError(path.refusal);
      return answer(await stub.readFile(path.value), (bytes) => new Response(bytes, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } }));
    }
    case "writeFile": {
      const path = parsePath(url.searchParams.get("path"));
      if (!path.ok) return apiError(path.refusal);
      const declared = Number(request.headers.get("content-length") ?? "0");
      const tooLarge = apiError({ status: 413, code: "too_large", message: `Files are limited to ${FILE_MAX_BYTES} bytes.` });
      if (declared > FILE_MAX_BYTES) return tooLarge;
      let bytes: Uint8Array;
      try {
        bytes = await readLimited(request.body, FILE_MAX_BYTES);
      } catch (error) {
        if (error instanceof TooLarge) return tooLarge;
        throw error;
      }
      return answer(await stub.writeFile(path.value, bytes), () => json({ ok: true }));
    }
    case "screenshot":
      return answer(await stub.screenshot(), (bytes) => new Response(bytes, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } }));
    case "desktop":
      return answer(await stub.desktopLink(url.origin), (value) => json(value));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const target = route(request.method, url.pathname);
    try {
      switch (target.kind) {
        case "health":
          return new Response("ok\n", { headers: { "cache-control": "no-store" } });
        case "redirect":
          return new Response(null, { status: 302, headers: { location: target.location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
        case "desktop":
          // The computer's Durable Object checks the link against its current boot and serves or proxies the request.
          return await computer(env, target.id).fetch(request);
        case "not_found":
          return target.api ? apiError({ status: 404, code: "not_found", message: "No such endpoint." }) : new Response("Not found\n", { status: 404 });
        case "method_not_allowed":
          return apiError({ status: 405, code: "method_not_allowed", message: `Use ${target.allow.join(" or ")}.` }, { allow: target.allow.join(", ") });
        case "collection":
        case "computer": {
          const refusal = await refuseApiRequest(request.headers, env.COMPUTERS_KEY_SHA256);
          if (refusal) return apiError(refusal, refusal.status === 401 ? { "www-authenticate": 'Bearer realm="laterdog-computers"' } : {});
          if (target.kind === "collection") return target.op === "list" ? await listComputers(env) : await createComputer(request, env);
          return await computerRequest(target.op, target.id, request, env, url);
        }
      }
    } catch (error) {
      const path = url.pathname.replace(/^(\/desktop\/[^/]+\/)[^/]+/, "$1<token>");
      console.error(`laterdog computers: ${request.method} ${path} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return apiError({ status: 500, code: "internal", message: "Something went wrong; the error was logged." });
    }
  },
} satisfies ExportedHandler<Env>;
