import { Readable, pipeline } from "node:stream";
import { PASS, type RouteHandler } from "./table.ts";
import { limitBytes } from "../laterdog/job-trace.ts";
import { desktopSupervisorToken, supervisorOrigin } from "../laterdog/config.ts";

const TRACE_PATH = /^\/api\/laterdog\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/trace$/;
const MAX_TRACE_BYTES = 160 * 1024 * 1024;

export function createJobTraceRoutes(fetchImpl: typeof fetch = fetch): RouteHandler {
  return async ({ res, method, path, json }) => {
    const match = TRACE_PATH.exec(path);
    if (!match) return PASS;
    if (method !== "GET") return json(res, 405, { error: "A trace can only be downloaded" });
    let origin: string; let token: string;
    try { origin = supervisorOrigin(); token = desktopSupervisorToken(); }
    catch (error) { return json(res, 503, { error: error instanceof Error ? error.message : String(error) }); }
    let response: Response;
    try { response = await fetchImpl(`${origin}/v1/jobs/${match[1]}/trace`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(180_000) }); }
    catch { return json(res, 503, { error: `The later.dog supervisor at ${origin} is unavailable.` }); }
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: unknown };
      return json(res, response.status, { error: typeof failure.error === "string" ? failure.error : "The trace could not be read." });
    }
    if (!response.body) return json(res, 502, { error: "The supervisor sent no trace." });
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-disposition": response.headers.get("content-disposition") ?? `attachment; filename="laterdog-job-${match[1]}-trace.jsonl"`,
    });
    await new Promise<void>((done) => {
      pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), limitBytes(MAX_TRACE_BYTES, "The trace"), res, (error) => {
        if (error) res.destroy();
        done();
      });
    });
  };
}
