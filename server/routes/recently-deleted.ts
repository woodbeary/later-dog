import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const RECENTLY_DELETED_OWNER_ONLY = "Only the owner can bring back a deleted dog.";

export interface RecentlyDeletedDog {
  id: string;
  name: string;
  at: number;
  purgeAt: number;
}

export interface RecentlyDeletedRouteDeps {
  mayRestore(auth: RequestAuth): boolean;
  list(): RecentlyDeletedDog[];
  restore(botId: string): boolean;
}

const RESTORE = /^\/api\/recently-deleted\/([^/]+)\/restore$/;

export function createRecentlyDeletedRoutes(deps: RecentlyDeletedRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (path === "/api/recently-deleted" && method === "GET") return json(res, 200, { dogs: deps.list() });
    const match = RESTORE.exec(path);
    if (!match || method !== "POST") return PASS;
    if (!deps.mayRestore(auth)) return json(res, 403, { error: RECENTLY_DELETED_OWNER_ONLY });
    return deps.restore(decodeURIComponent(match[1]!)) ? json(res, 200, { dogs: deps.list() }) : json(res, 404, { error: "That dog is not in Recently deleted." });
  };
}
