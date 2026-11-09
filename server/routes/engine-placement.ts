import { z } from "zod";
import { fromLocalTools } from "../request-auth.ts";
import type { RemoteEngineChoice } from "../laterdog/engine-placement.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const ENGINE_PLACEMENT_PATH = /^\/api\/bots\/([\w-]+)\/engine-placement$/;

const placementSchema = z.object({ placement: z.enum(["computer", "home"]) }).strict();

export interface EnginePlacementRouteDeps {
  botExists(botId: string): boolean;
  read(botId: string): RemoteEngineChoice;
  save(botId: string, computer: boolean): RemoteEngineChoice;
}

const wire = (choice: RemoteEngineChoice) => ({
  botId: choice.botId,
  placement: choice.computer ? "computer" : "home",
  fromEnvironment: choice.fromEnvironment,
  engines: ["claude"],
});

export function createEnginePlacementRoutes(deps: EnginePlacementRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = ENGINE_PLACEMENT_PATH.exec(path);
    if (!match) return PASS;
    if (method !== "GET" && method !== "PUT") return json(res, 405, { error: "method_not_allowed" });
    if (!auth.scopes.includes("admin") || fromLocalTools(auth)) return json(res, 403, { error: "Only the owner can choose where a dog's engine runs." });
    const botId = match[1]!;
    if (!deps.botExists(botId)) return json(res, 404, { error: "no such bot" });
    if (method === "GET") return json(res, 200, wire(deps.read(botId)));
    const parsed = placementSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Send placement: \"computer\" or \"home\"." });
    const current = deps.read(botId);
    if (current.fromEnvironment && parsed.data.placement === "home") {
      return json(res, 409, { error: "This dog's engine is placed on its computer by the home's environment, so it cannot be changed here." });
    }
    try {
      return json(res, 200, wire(deps.save(botId, parsed.data.placement === "computer")));
    } catch (error) {
      return json(res, 500, { error: (error as Error).message });
    }
  };
}
