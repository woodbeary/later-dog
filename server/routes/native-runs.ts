import type { NativeActor, NativeRun } from "../../shared/native-runs.ts";
import type { NativeRunStore } from "../laterdog/native-run-store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface NativeRunRouteDeps {
  store: NativeRunStore;
  visibleThreads(auth: RequestAuth): (threadId: string) => boolean;
  stop(run: NativeRun, actor: NativeActor): Promise<void>;
}

export function createNativeRunRoutes(deps: NativeRunRouteDeps): RouteHandler {
  return async ({ path, method, auth, url, res, json }) => {
    const match = path.match(/^\/api\/threads\/([\w-]+)\/runs(?:\/([\w-]+)(?:\/actors\/([^/]+)\/stop)?)?$/);
    if (!match || (method !== "GET" && method !== "POST")) return PASS;
    const [, threadId, runId, encodedActorId] = match;
    if (!deps.visibleThreads(auth)(threadId)) return json(res, 404, { error: "No such conversation" });
    if (method === "GET" && !encodedActorId) {
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) return json(res, 400, { error: "Invalid page limit" });
      const cursor = url.searchParams.get("cursor") ?? url.searchParams.get(runId ? "after" : "before") ?? undefined;
      if (!runId) return json(res, 200, deps.store.list(threadId, cursor, limit));
      const detail = deps.store.detail(threadId, runId, cursor, limit);
      return detail ? json(res, 200, detail) : json(res, 404, { error: "No such activity" });
    }
    if (method !== "POST" || !runId || !encodedActorId) return PASS;
    if (!auth.scopes.includes("client") && !auth.scopes.includes("admin")) return json(res, 403, { error: "Conversation access required" });
    let actorId: string;
    try { actorId = decodeURIComponent(encodedActorId); } catch { return json(res, 400, { error: "Invalid helper" }); }
    const run = deps.store.get(runId);
    if (!run || run.threadId !== threadId) return json(res, 404, { error: "No such activity" });
    const actor = run.actors.find(actor => actor.id === actorId);
    if (!actor) return json(res, 404, { error: "No such helper" });
    if (!actor.canStop || run.observation !== "live" || (actor.state !== "running" && actor.state !== "waiting")) return json(res, 409, { error: "This helper cannot be stopped here" });
    try { await deps.stop(run, actor); }
    catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "The helper is no longer available" }); }
    return json(res, 202, { status: "requested" });
  };
}
