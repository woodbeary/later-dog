import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const MAC_ACCESS_HELP = "Send mode (ask, always or never) for any Mac, and computers: { [id]: ask, always or never } for one Mac.";
export const MAC_ACCESS_OWNER_ONLY = "Only the owner can change who uses their Mac.";

export interface MacAccessRouteDeps {
  cloudHome: boolean;
  mayChange(auth: RequestAuth): boolean;
  update(body: unknown): boolean;
  view(): unknown;
}

export function createMacAccessRoutes(deps: MacAccessRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/mac-access" || !deps.cloudHome || (method !== "GET" && method !== "PUT")) return PASS;
    if (method === "PUT") {
      if (!deps.mayChange(auth)) return json(res, 403, { error: MAC_ACCESS_OWNER_ONLY });
      if (!deps.update(await readBody(req, 64_000))) return json(res, 400, { error: MAC_ACCESS_HELP });
    }
    return json(res, 200, deps.view());
  };
}
