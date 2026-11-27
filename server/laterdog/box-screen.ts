import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { computersConnection, computersKey } from "./cloud-computers.ts";
import type { RemoteExec } from "./page-tools.ts";

export const BOX_STAYS_ON_COMPUTER: ReadonlySet<string> = new Set(["exec"]);
const DOG = /^[\w-]{1,64}$/;
const FILE_LIMIT = 256 * 1024;
const RUN_TIMEOUT_MS = 330_000;
const RESULT_LIMIT = 8 * 1024 * 1024;

export function readBoxScreens(file: string): Set<string> {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > FILE_LIMIT) return new Set();
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { dogs?: unknown };
    return new Set(Array.isArray(parsed.dogs) ? parsed.dogs.filter((dog): dog is string => typeof dog === "string" && DOG.test(dog)) : []);
  } catch {
    return new Set();
  }
}

export function setBoxScreen(file: string, dog: string, on: boolean): Set<string> {
  const dogs = readBoxScreens(file);
  if (on) dogs.add(dog); else dogs.delete(dog);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, `${JSON.stringify({ version: 1, dogs: [...dogs].sort() })}\n`, { mode: 0o600 });
  return dogs;
}

export const screensOnBox = (file: string, dog: string): boolean => DOG.test(dog) && readBoxScreens(file).has(dog);

export function boxScreenExec(dog: string, send: typeof fetch = fetch): RemoteExec {
  if (!DOG.test(dog)) throw new Error("invalid dog id");
  return async (command, signal) => {
    const connection = computersConnection();
    if (!connection) return { ok: false, exitCode: null, stdout: "", stderr: "later.dog's own cloud computers are not set up on this installation" };
    let response: Response;
    try {
      response = await send(`${connection.api}/box/desktops/${encodeURIComponent(dog)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${computersKey(connection)}` },
        body: JSON.stringify({ command, timeoutMs: 300_000 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, exitCode: null, stdout: "", stderr: "The personal box did not answer." };
    }
    const text = (await response.text()).slice(0, RESULT_LIMIT);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch {}
    if (!response.ok) {
      const error = body.error && typeof body.error === "object" ? (body.error as { message?: unknown }).message : undefined;
      return { ok: false, exitCode: null, stdout: "", stderr: typeof error === "string" ? error : `The personal box answered ${response.status}.` };
    }
    return {
      ok: body.ok === true,
      exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
      stdout: typeof body.stdout === "string" ? body.stdout : "",
      stderr: typeof body.stderr === "string" ? body.stderr : "",
    };
  };
}

export function createBoxScreenRoutes(deps: { file: string; allowed(auth: RequestAuth): boolean; dogExists(id: string): boolean }): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = /^\/api\/laterdog\/box-screens(?:\/([\w-]{1,64}))?$/.exec(path);
    if (!match) return PASS;
    if (!deps.allowed(auth)) return json(res, 403, { error: "Only the owner can choose where dogs' screens run." });
    res.setHeader("cache-control", "no-store");
    const dog = match[1];
    if (!dog) return method === "GET" ? json(res, 200, { dogs: [...readBoxScreens(deps.file)] }) : json(res, 405, { error: "method not allowed" });
    if (!deps.dogExists(dog)) return json(res, 404, { error: "No such dog." });
    if (method === "GET") return json(res, 200, { dog, box: screensOnBox(deps.file, dog) });
    if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
    const body = await readBody(req, 1024).catch(() => null) as { box?: unknown } | null;
    if (typeof body?.box !== "boolean") return json(res, 400, { error: "box must be true or false" });
    setBoxScreen(deps.file, dog, body.box);
    return json(res, 200, { dog, box: body.box });
  };
}
