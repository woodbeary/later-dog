import { z } from "zod";
import { fromLocalTools } from "../request-auth.ts";
import { SEARCH_INDEX_MODES, type SearchIndexMode, type SearchIndexStatus } from "../laterdog/search-index-wiring.ts";
import { PASS, type RouteHandler } from "./table.ts";

const modeSchema = z.object({ mode: z.enum(SEARCH_INDEX_MODES) }).strict();

export interface SearchIndexRouteDeps {
  status(): SearchIndexStatus | null;
  setMode(mode: SearchIndexMode): SearchIndexStatus | null;
}

export function createSearchIndexRoutes(deps: SearchIndexRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/search-index") return PASS;
    if (method !== "GET" && method !== "PUT") return json(res, 405, { error: "method_not_allowed" });
    if (!auth.scopes.includes("admin") || fromLocalTools(auth)) return json(res, 403, { error: "Only the owner can see or change the search index." });
    if (method === "GET") {
      const status = deps.status();
      return status ? json(res, 200, status) : json(res, 404, { error: "The search index runs only on a Cloud home." });
    }
    const parsed = modeSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Send mode: off, shadow or remote." });
    try {
      const status = deps.setMode(parsed.data.mode);
      return status ? json(res, 200, status) : json(res, 404, { error: "The search index runs only on a Cloud home." });
    } catch (error) {
      return json(res, 500, { error: (error as Error).message });
    }
  };
}
