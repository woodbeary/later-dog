import { z } from "zod";
import { fromLocalTools } from "../request-auth.ts";
import type { PoolSetting } from "../laterdog/pool-opener.ts";
import { PASS, type RouteHandler } from "./table.ts";

const poolSchema = z.object({ enabled: z.boolean(), bots: z.array(z.string().regex(/^[\w-]{1,128}$/)).max(500).optional(), skip: z.array(z.string().regex(/^[\w-]{1,128}$/)).max(500).optional() }).strict();

export interface EnginePoolRouteDeps {
  read(): PoolSetting;
  save(setting: PoolSetting): PoolSetting;
}

export function createEnginePoolRoutes(deps: EnginePoolRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/engine-pool") return PASS;
    if (method !== "GET" && method !== "PUT") return json(res, 405, { error: "method_not_allowed" });
    if (!auth.scopes.includes("admin") || fromLocalTools(auth)) return json(res, 403, { error: "Only the owner can choose which dogs use the warm engine pool." });
    if (method === "GET") return json(res, 200, deps.read());
    const parsed = poolSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Send enabled: true or false, and optionally bots: the only dog ids to use it, or skip: dog ids to leave off it." });
    try { return json(res, 200, deps.save(parsed.data)); }
    catch (error) { return json(res, 500, { error: (error as Error).message }); }
  };
}
