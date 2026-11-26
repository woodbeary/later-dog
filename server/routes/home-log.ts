import { fromLocalTools, type RequestAuth } from "../request-auth.ts";
import { parseHomeLogQuery, readHomeLog } from "../laterdog/home-server-log.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const HOME_LOG_PATH = "/api/home-log";

export interface HomeLogRouteDeps {
  dir(): string | null;
}

export function homeLogReader(auth: RequestAuth): boolean {
  return auth.kind === "session" && auth.scopes.includes("admin") && !fromLocalTools(auth);
}

export function createHomeLogRoutes(deps: HomeLogRouteDeps): RouteHandler {
  return async ({ res, url, path, method, auth, json }) => {
    if (path !== HOME_LOG_PATH) return PASS;
    if (method !== "GET") return json(res, 405, { error: "method_not_allowed" });
    const dir = deps.dir();
    if (!dir) return json(res, 404, { error: "Only a later.dog Cloud home keeps a server log." });
    if (!homeLogReader(auth)) return json(res, 403, { error: "Only the owner of this Cloud can read its server log." });
    const query = parseHomeLogQuery(url.searchParams);
    if (typeof query === "string") return json(res, 400, { error: query });
    const text = await readHomeLog(dir, query);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(text);
  };
}
