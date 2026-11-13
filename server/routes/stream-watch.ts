import { updateStreamWatch, type StreamWatchClient } from "../stream-watch.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const STREAM_WATCH_PATH = "/api/events/watch";

export interface StreamWatchRouteDeps {
  clients(): Iterable<StreamWatchClient>;
}

export function createStreamWatchRoutes(deps: StreamWatchRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (method !== "POST" || path !== STREAM_WATCH_PATH) return PASS;
    const result = updateStreamWatch(deps.clients(), await readBody(req), auth.kind === "session" ? auth.session.id : undefined);
    return result.ok ? json(res, 200, { threads: result.threads }) : json(res, result.status, { error: result.error });
  };
}
