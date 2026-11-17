import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const ALWAYS_ALLOWED = /^\/api\/bots\/([\w-]+)\/always-allowed(?:\/([^/]+))?$/;

export interface AlwaysAllowedRouteDeps {
  dog(botId: string): { id: string } | null | undefined;
  mayManage(auth: RequestAuth): boolean;
  list(botId: string): unknown;
  resume(botId: string): void;
  remove(botId: string, itemId: string): boolean;
}

export function createAlwaysAllowedRoutes(deps: AlwaysAllowedRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    const m = ALWAYS_ALLOWED.exec(path);
    if (!m) return PASS;
    const bot = deps.dog(m[1]!);
    if (!bot) return json(res, 404, { error: "no such dog" });
    if (!deps.mayManage(auth)) return json(res, 403, { error: "Only the owner or an admin can see or change what a dog may always do." });
    if (method === "GET" && !m[2]) return json(res, 200, deps.list(bot.id));
    if (method === "POST" && m[2] === "resume") {
      deps.resume(bot.id);
      return json(res, 200, deps.list(bot.id));
    }
    if (method === "DELETE" && m[2]) {
      if (!deps.remove(bot.id, decodeURIComponent(m[2]))) return json(res, 404, { error: "nothing like that is always allowed" });
      return json(res, 200, deps.list(bot.id));
    }
    return json(res, 405, { error: "Unsupported operation" });
  };
}
