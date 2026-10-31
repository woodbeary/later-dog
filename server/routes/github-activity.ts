import type { GitHubActivity } from "../github-activity.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface GitHubActivityRouteDeps {
  read: () => Promise<GitHubActivity>;
}

const PATH = "/api/usage/github";

export function createGitHubActivityRoutes(deps: GitHubActivityRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "GET" || path !== PATH) return PASS;
    res.setHeader("cache-control", "no-store");
    json(res, 200, await deps.read());
  };
}
