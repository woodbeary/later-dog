import { PASS, type RouteHandler } from "./table.ts";

export const MAC_ACCESS_HELP = "Send mode (ask, always or never) and, optionally, the dogs that are always allowed.";

export interface MacAccessRouteDeps {
  cloudHome: boolean;
  update(body: unknown): boolean;
  view(): unknown;
}

export function createMacAccessRoutes(deps: MacAccessRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== "/api/mac-access" || !deps.cloudHome || (method !== "GET" && method !== "PUT")) return PASS;
    if (method === "PUT" && !deps.update(await readBody(req, 64_000))) return json(res, 400, { error: MAC_ACCESS_HELP });
    return json(res, 200, deps.view());
  };
}
