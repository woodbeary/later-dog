import { screenGoals, type ScreenGoalMessage } from "../../shared/screen-goals.ts";
import { PASS, type RouteHandler } from "./table.ts";

const SCREEN_GOALS_PATH = /^\/api\/threads\/([\w-]+)\/screen-goals$/;

export interface ScreenGoalRouteDeps {
  dogThread(threadId: string): readonly ScreenGoalMessage[] | null;
}

export function createScreenGoalRoutes(deps: ScreenGoalRouteDeps): RouteHandler {
  return async ({ res, method, path, json }) => {
    const m = SCREEN_GOALS_PATH.exec(path);
    if (!m || method !== "GET") return PASS;
    const messages = deps.dogThread(m[1]!);
    if (!messages) return json(res, 404, { error: "no such conversation" });
    return json(res, 200, { goals: screenGoals(messages) });
  };
}
