import { hostedSlackManagement } from "../hosted-slack.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { dogCanAct } from "../laterdog/dog-can-act.ts";

export interface HostedSlackRouteDeps {
  bot(id: string): { id: string } | null | undefined;
  hostedReady(): boolean;
  env?: NodeJS.ProcessEnv;
}

export function createHostedSlackRoutes(deps: HostedSlackRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/slack-management$/);
    if (!m || method !== "GET") return PASS;
    const bot = deps.bot(m[1]!);
    if (!dogCanAct(bot)) return json(res, 404, { error: "no such bot" });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, hostedSlackManagement(bot.id, deps.hostedReady(), deps.env));
  };
}
