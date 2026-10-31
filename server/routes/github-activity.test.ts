import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { GitHubActivity } from "../github-activity.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createGitHubActivityRoutes } from "./github-activity.ts";
import { PASS, type RouteContext } from "./table.ts";

function context(method: string, path: string) {
  const headers: Record<string, string> = {};
  const sent: { status: number; body: unknown }[] = [];
  const res = { setHeader: (name: string, value: string) => { headers[name] = value; } } as unknown as ServerResponse;
  const ctx = {
    req: {} as IncomingMessage,
    res,
    url: new URL(`http://localhost${path}`),
    path,
    method,
    auth: {} as RequestAuth,
    json: ((_res: ServerResponse, status: number, body: unknown) => { sent.push({ status, body }); }) as RouteContext["json"],
    readBody: (async () => "") as unknown as RouteContext["readBody"],
  } satisfies RouteContext;
  return { ctx, headers, sent };
}

describe("GitHub activity route", () => {
  it("answers GET /api/usage/github with the activity and no caching", async () => {
    const activity: GitHubActivity = { state: "signedOut" };
    const read = vi.fn(async () => activity);
    const { ctx, headers, sent } = context("GET", "/api/usage/github");
    expect(await createGitHubActivityRoutes({ read })(ctx)).toBeUndefined();
    expect(sent).toEqual([{ status: 200, body: activity }]);
    expect(headers["cache-control"]).toBe("no-store");
  });

  it("passes other requests on without asking GitHub", async () => {
    const read = vi.fn(async (): Promise<GitHubActivity> => ({ state: "signedOut" }));
    const route = createGitHubActivityRoutes({ read });
    expect(await route(context("POST", "/api/usage/github").ctx)).toBe(PASS);
    expect(await route(context("GET", "/api/usage").ctx)).toBe(PASS);
    expect(read).not.toHaveBeenCalled();
  });
});
