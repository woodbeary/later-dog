import type { SignedCapabilityClaims } from "../../../../shared/signed-capability.ts";
import { INDEX_BUDGET_MS, INDEX_ROUTE, type IndexOperation } from "../../../../shared/search-index-protocol.ts";
import { INDEX_REQUEST_ERROR, type SearchIndex } from "./person-index-store.ts";

export type IndexPort = { [Operation in keyof SearchIndex]: (...args: Parameters<SearchIndex[Operation]>) => Promise<ReturnType<SearchIndex[Operation]>> | ReturnType<SearchIndex[Operation]> };

const OPERATIONS = new Set<string>(Object.keys(INDEX_BUDGET_MS));
const BUDGET_SPENT = Symbol("budget");

function answer(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof BUDGET_SPENT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const spent = new Promise<typeof BUDGET_SPENT>((resolve) => { timer = setTimeout(() => resolve(BUDGET_SPENT), ms); });
  try {
    return await Promise.race([work, spent]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function serveIndex(request: Request, claims: SignedCapabilityClaims, index: IndexPort, budgets: Record<IndexOperation, number> = INDEX_BUDGET_MS): Promise<Response> {
  const operation = new URL(request.url).pathname.slice(INDEX_ROUTE.length);
  if (!OPERATIONS.has(operation)) return answer(404, { error: "not_found" });
  if (claims.kind !== "index") return answer(403, { error: "capability_wrong-kind" });
  if (request.method !== "POST") return answer(405, { error: "post_only" });
  const body = await request.json().catch(() => null);
  if (operation !== "stats" && (!body || typeof body !== "object")) return answer(400, { error: "a JSON body is required" });
  const op = operation as IndexOperation;
  const started = Date.now();
  const work = Promise.resolve().then(() => (op === "stats" ? index.stats() : (index[op] as (input: unknown) => unknown)(body)));
  work.catch(() => {});
  try {
    const result = await withinBudget(work, budgets[op]);
    if (result === BUDGET_SPENT) return answer(503, { error: "index_unavailable", reason: "budget", budgetMs: budgets[op] });
    return answer(200, { ok: true, result, ms: Date.now() - started });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(INDEX_REQUEST_ERROR)) return answer(400, { error: message.slice(message.indexOf(INDEX_REQUEST_ERROR) + INDEX_REQUEST_ERROR.length) });
    return answer(503, { error: "index_unavailable", reason: "failed" });
  }
}
