import { PASS, type RouteHandler } from "./table.ts";

export interface StorageRouteDeps {
  storage(): unknown;
  clean(): unknown;
  measure(): boolean;
  awayPlan?: { last(): unknown; measuring(): boolean; measure(): boolean };
  bringAllBack?(): Promise<{ ok: boolean; message: string }>;
}

export function createStorageRoutes(deps: StorageRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method === "GET" && path === "/api/storage") return json(res, 200, deps.storage());
    if (method === "POST" && path === "/api/storage/clean") return json(res, 200, { run: deps.clean(), storage: deps.storage() });
    if (method === "POST" && path === "/api/storage/measure") return json(res, 200, { started: deps.measure() });
    if (deps.awayPlan && method === "GET" && path === "/api/storage/away-plan") return json(res, 200, { measuring: deps.awayPlan.measuring(), plan: deps.awayPlan.last() });
    if (deps.awayPlan && method === "POST" && path === "/api/storage/away-plan") return json(res, 200, { started: deps.awayPlan.measure() });
    if (deps.bringAllBack && method === "POST" && path === "/api/storage/folders/bring-back") {
      const answer = await deps.bringAllBack();
      return json(res, answer.ok ? 200 : 409, answer);
    }
    return PASS;
  };
}
