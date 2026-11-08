import type { UsageRow } from "../usage-ledger.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createExecutionReceiptsRoute(deps: { rows(): UsageRow[] }): RouteHandler {
  return async ({ path, method, auth, url, res, json }) => {
    if (path !== "/api/usage/executions" || method !== "GET") return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "Execution receipts require workspace admin access." });
    const limit = Number(url.searchParams.get("limit") ?? "50");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return json(res, 400, { error: "limit must be between 1 and 200" });
    const rows = deps.rows();
    const attributed = rows.filter((row) => row.execution);
    res.setHeader("cache-control", "no-store");
    return json(res, 200, {
      coverage: { recordedTurns: rows.length, receipts: attributed.length, legacyTurns: rows.length - attributed.length },
      receipts: attributed.slice(-limit).reverse().map(({ at, botId, threadId, instanceId, model, input, output, cachedInput, costUsd, costSource, execution }) => ({ at, botId, threadId, instanceId, model, input, output, cachedInput, costUsd, costSource, execution })),
      limits: "Last thirty days. Provider success is not verified task completion; recorded costs are not subscription invoices.",
    });
  };
}
