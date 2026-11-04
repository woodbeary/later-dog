import { PASS, type RouteHandler } from "./table.ts";

export interface StorageRouteDeps {
  storage(): unknown;
  clean(): unknown;
}

export function createStorageRoutes(deps: StorageRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method === "GET" && path === "/api/storage") return json(res, 200, deps.storage());
    if (method === "POST" && path === "/api/storage/clean") return json(res, 200, { run: deps.clean(), storage: deps.storage() });
    return PASS;
  };
}
