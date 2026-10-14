import type { TypingService } from "../laterdog/typing-suggestions.ts";
import { parseTypingRequest } from "../laterdog/typing-context.ts";
import type { RankResult } from "../laterdog/typing-rank.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TypingSuggestionsRouteDeps {
  typing: TypingService;
  rankingReady(): boolean;
  rank(input: { typed: string; lastDogMessage: string; candidates: string[] }, signal: AbortSignal): Promise<RankResult>;
}

const MAX_BODY = 32 * 1024;
const MAX_FIELD = 512;
const text = (value: unknown, limit: number) => (typeof value === "string" ? value.slice(0, limit) : "");

export function createTypingSuggestionsRoutes(deps: TypingSuggestionsRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (method !== "POST" || !path.startsWith("/api/typing/")) return PASS;
    res.setHeader("cache-control", "no-store");
    const aborted = new AbortController();
    res.on("close", () => aborted.abort());
    if (path === "/api/typing/complete") {
      const parsed = parseTypingRequest(await readBody(req, MAX_BODY));
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      const result = await deps.typing.complete(parsed.request, aborted.signal);
      if (result.ok) return json(res, 200, { completion: result.completion, source: result.source, ms: result.ms, ...(result.cached ? { cached: true } : {}) });
      return json(res, 200, { completion: "", reason: result.reason });
    }
    if (path === "/api/typing/rank") {
      const body = await readBody(req, MAX_BODY);
      const candidates: unknown = body?.candidates;
      if (!Array.isArray(candidates) || !candidates.every((item) => typeof item === "string")) return json(res, 400, { error: "Send the candidates as a list of text." });
      if (!deps.rankingReady()) return json(res, 200, { index: null, reason: "off" });
      const result = await deps.rank({ typed: text(body?.typed, MAX_FIELD), lastDogMessage: text(body?.lastMessage, MAX_FIELD), candidates: candidates as string[] }, aborted.signal);
      if (result.ok) return json(res, 200, { index: result.index, ms: result.ms });
      return json(res, 200, { index: null, reason: result.reason });
    }
    if (path === "/api/typing/test") {
      const body = await readBody(req, 8192);
      const draft = body && typeof body.accountId === "string" && typeof body.token === "string"
        ? { accountId: body.accountId.slice(0, 64), token: body.token.slice(0, 512), ...(typeof body.model === "string" ? { model: body.model.slice(0, 200) } : {}) }
        : undefined;
      const result = await deps.typing.test(draft);
      if (result.ok) return json(res, 200, { ok: true, ms: result.ms });
      return json(res, 200, { ok: false, reason: result.reason });
    }
    return PASS;
  };
}

