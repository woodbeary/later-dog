import { fromLocalTools } from "../request-auth.ts";
import { coordinatorSettingSchema, type CoordinatorSetting } from "../laterdog/coordinator-setting.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { z } from "zod";

export interface CoordinatorRouteDeps {
  available(): boolean;
  read(): CoordinatorSetting & Record<string, unknown>;
  change(change: z.infer<typeof coordinatorSettingSchema>): CoordinatorSetting | Promise<CoordinatorSetting>;
}

export function createCoordinatorRoutes(deps: CoordinatorRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/coordinator") return PASS;
    if (method !== "GET" && method !== "PUT") return json(res, 405, { error: "method_not_allowed" });
    if (!auth.scopes.includes("admin") || fromLocalTools(auth)) return json(res, 403, { error: "Only the owner can see or change the coordinator switches." });
    if (!deps.available()) return json(res, 404, { error: "The coordinator runs only on a Cloud home." });
    if (method === "GET") return json(res, 200, deps.read());
    const parsed = coordinatorSettingSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Send capabilities (random or signed) and/or queue, routines and inbox ({dogId or *: container, object or null})." });
    return json(res, 200, await deps.change(parsed.data));
  };
}
