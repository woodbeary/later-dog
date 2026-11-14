import type { ContextBreakdown } from "../../shared/context-breakdown.ts";
import { PASS, type RouteHandler } from "./table.ts";

const CHAT_CONTEXT_PATH = /^\/api\/threads\/([\w-]+)\/context$/;

export interface ChatContextRouteDeps {
  breakdown(threadId: string): Promise<ContextBreakdown | null> | undefined;
}

function sizesOnly(breakdown: ContextBreakdown): ContextBreakdown {
  return {
    at: breakdown.at,
    source: breakdown.source,
    total: breakdown.total,
    window: breakdown.window,
    parts: breakdown.parts.map((part) => ({ id: part.id, tokens: part.tokens, ...(part.deferred ? { deferred: true as const } : {}) })),
    ...(breakdown.compactsAt !== undefined ? { compactsAt: breakdown.compactsAt } : {}),
  };
}

export function createChatContextRoutes(deps: ChatContextRouteDeps): RouteHandler {
  return async ({ res, method, path, json }) => {
    const m = CHAT_CONTEXT_PATH.exec(path);
    if (!m || method !== "GET") return PASS;
    const pending = deps.breakdown(m[1]!);
    if (!pending) return json(res, 404, { error: "no such conversation" });
    const breakdown = await pending;
    if (!breakdown) return json(res, 404, { error: "nothing yet" });
    return json(res, 200, sizesOnly(breakdown));
  };
}
