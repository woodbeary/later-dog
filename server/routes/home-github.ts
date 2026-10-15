import { fromLocalTools, type RequestAuth } from "../request-auth.ts";
import type { HomeGitHubStatus } from "../laterdog/home-github.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const HOME_GITHUB_PATH = "/api/home/github";
export const HOME_GITHUB_OWNER_ONLY = "Only the owner of this My Cloud can connect GitHub.";

export interface HomeGitHubRouteDeps {
  cloudHome: boolean;
  github: {
    status(): Promise<HomeGitHubStatus>;
    connect(): Promise<HomeGitHubStatus>;
    disconnect(): Promise<HomeGitHubStatus>;
  };
}

export function homeOwner(auth: RequestAuth): boolean {
  return auth.kind === "session" && auth.scopes.includes("admin") && !fromLocalTools(auth);
}

const ACTIONS: Record<string, "GET" | "POST"> = { "": "GET", "/connect": "POST", "/disconnect": "POST" };

export function createHomeGitHubRoutes(deps: HomeGitHubRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (!deps.cloudHome || !path.startsWith(HOME_GITHUB_PATH)) return PASS;
    const action = path.slice(HOME_GITHUB_PATH.length);
    if (!Object.hasOwn(ACTIONS, action)) return PASS;
    res.setHeader("cache-control", "no-store");
    if (!homeOwner(auth)) return json(res, 403, { error: HOME_GITHUB_OWNER_ONLY });
    if (method !== ACTIONS[action]) return json(res, 405, { error: "method not allowed" });
    try {
      if (action === "/connect") return json(res, 202, await deps.github.connect());
      if (action === "/disconnect") return json(res, 200, await deps.github.disconnect());
      return json(res, 200, await deps.github.status());
    } catch (error) {
      return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
