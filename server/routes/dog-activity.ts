import { ACTIVITY_DAYS, dogActivity, type ActivityMessage } from "../laterdog/dog-activity.ts";
import { PASS, type RouteHandler } from "./table.ts";

const ACTIVITY_PATH = /^\/api\/bots\/([\w-]+)\/activity$/;
const DAY_MS = 86_400_000;

export interface DogActivityRouteDeps {
  threads(botId: string): readonly (readonly ActivityMessage[])[] | null;
  turnTimes(botId: string, since: number): readonly number[];
  now?: () => number;
}

export function createDogActivityRoutes(deps: DogActivityRouteDeps): RouteHandler {
  return async ({ res, method, path, url, json }) => {
    const m = ACTIVITY_PATH.exec(path);
    if (!m || method !== "GET") return PASS;
    const threads = deps.threads(m[1]!);
    if (!threads) return json(res, 404, { error: "no such bot" });
    const asked = Number(url.searchParams.get("days") ?? ACTIVITY_DAYS);
    const days = Number.isInteger(asked) && asked >= 1 && asked <= ACTIVITY_DAYS ? asked : ACTIVITY_DAYS;
    const now = deps.now?.() ?? Date.now();
    return json(res, 200, dogActivity({ threads, turnTimes: deps.turnTimes(m[1]!, now - (days + 1) * DAY_MS), now, days }));
  };
}
