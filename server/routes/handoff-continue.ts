import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface HandoffRoot {
  id: string;
  threadId: string;
  parentId?: string | null;
}

export interface HandoffContinueRouteDeps {
  root(id: string): HandoffRoot | undefined;
  refusal(auth: RequestAuth, threadId: string): string | null;
  continueTree(id: string): object;
  markContinuing(threadId: string, handoffId: string): void;
}

export function createHandoffContinueRoutes(deps: HandoffContinueRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    const m = path.match(/^\/api\/handoffs\/([\w-]+)\/continue$/);
    if (!m || method !== "POST") return PASS;
    const root = deps.root(m[1]!);
    if (!root || root.parentId) return json(res, 404, { error: "no such work to continue" });
    const notYours = deps.refusal(auth, root.threadId);
    if (notYours) return json(res, 403, { error: notYours });
    try {
      const result = deps.continueTree(root.id);
      deps.markContinuing(root.threadId, root.id);
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, 409, { error: error instanceof Error ? error.message : "that work could not be continued" });
    }
  };
}
