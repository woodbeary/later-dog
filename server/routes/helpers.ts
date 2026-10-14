import type { HelperBoard } from "../laterdog/helper-board.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface HelpersRouteDeps {
  board: Pick<HelperBoard, "snapshot">;
  visibleThreads(auth: RequestAuth): (threadId: string) => boolean;
}

export function createHelpersRoutes(deps: HelpersRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (method !== "GET" || path !== "/api/helpers") return PASS;
    return json(res, 200, deps.board.snapshot(deps.visibleThreads(auth)));
  };
}
