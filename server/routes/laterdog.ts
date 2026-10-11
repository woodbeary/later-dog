import { PASS, type RouteHandler } from "./table.ts";
import { desktopSupervisorToken, supervisorOrigin } from "../laterdog/config.ts";
import { wakeupPullActive } from "../laterdog/wakeups.ts";

const FORWARDED_QUERY = ["ids", "bot", "limit", "after"];
function queryFor(url: URL): string {
  const kept = new URLSearchParams();
  for (const name of FORWARDED_QUERY) { const value = url.searchParams.get(name); if (value !== null && value.length <= 4000) kept.set(name, value); }
  const text = kept.toString();
  return text ? `?${text}` : "";
}

export function createLaterDogRoutes(): RouteHandler {
  return async ({ req, res, method, path, url, json, readBody }) => {
    if (!path.startsWith("/api/laterdog/")) return PASS;
    const suffix = path.slice("/api/laterdog".length);
    if (!/^\/(workspace|verification-policy|github\/(?:access|login)|profiles\/[a-zA-Z0-9_-]+\/(access|tasks)|observations|repositories|jobs(?:\/[\w-]+(?:\/(action|patch|activity|screen))?)?|bridge\/(?:devices(?:\/[\w-]+)?|pairing|requests))$/.test(suffix)) return json(res,404,{ error: "Unknown workspace route" });
    let origin: string; let token: string;
    // A misconfigured hosted connection (no token file, bad URL) is reported as itself, not as an unreachable supervisor.
    try { origin = supervisorOrigin(); token = desktopSupervisorToken(); }
    catch (error) { return json(res,503,{ error: error instanceof Error ? error.message : String(error) }); }
    try {
      const body = ["POST","PUT"].includes(method) ? JSON.stringify(await readBody(req,200_000)) : undefined;
      // Only the cloud task reads take a query (which jobs, and where a progress log resumes); nothing else is forwarded.
      const query = method === "GET" && /^\/jobs(?:\/[\w-]+\/activity)?$/.test(suffix) ? queryFor(url) : "";
      const response = await fetch(`${origin}/v1${suffix}${query}`,{ method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body }), redirect: "error", signal: AbortSignal.timeout(method === "GET" ? (suffix.endsWith("/activity") ? 45_000 : 10_000) : 660_000) });
      const result = await response.json() as Record<string, unknown>;
      // A hosted supervisor cannot know that this desktop pulls its wake-ups (server/laterdog/wakeups.ts).
      if (suffix === "/workspace" && response.ok && wakeupPullActive()) result.wakeupsConfigured = true;
      return json(res,response.status,result);
    } catch {
      return json(res,503,{ error: `The later.dog supervisor at ${origin} is unavailable. Start it with pnpm laterdog:supervisor, or save a hosted connection in ~/.laterdog/supervisor.json.` });
    }
  };
}
