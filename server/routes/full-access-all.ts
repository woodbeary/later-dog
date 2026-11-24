import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const FULL_ACCESS_ALL_HELP = "Send { \"enabled\": true } or { \"enabled\": false }.";
export const FULL_ACCESS_ALL_OWNER_ONLY = "Only the owner can give all their dogs Full access.";

export interface FullAccessAllRouteDeps {
  cloudHome: boolean;
  mayChange(auth: RequestAuth): boolean;
  update(body: unknown): boolean;
  view(): unknown;
}

export function createFullAccessAllRoutes(deps: FullAccessAllRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/full-access-all" || !deps.cloudHome || (method !== "GET" && method !== "PUT")) return PASS;
    if (method === "PUT") {
      if (!deps.mayChange(auth)) return json(res, 403, { error: FULL_ACCESS_ALL_OWNER_ONLY });
      if (!deps.update(await readBody(req, 4_000))) return json(res, 400, { error: FULL_ACCESS_ALL_HELP });
    }
    return json(res, 200, deps.view());
  };
}
