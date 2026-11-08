import { z } from "zod";
import { executionAdvice, type AdviceCandidate } from "../laterdog/execution-advisor.ts";
import type { UsageRow } from "../usage-ledger.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

const requestSchema = z.object({ task: z.string().trim().min(1).max(2000) }).strict();

export function createExecutionAdviceRoute(deps: {
  active(capability: unknown): boolean;
  wholeDogHistory(threadId: string): boolean;
  candidates(): Promise<AdviceCandidate[]>;
  rows(): UsageRow[];
  current(botId: string, threadId: string): ModelSelection | undefined;
  now?: () => number;
}): InternalRouteHandler {
  return async ({ path, method, capability, sender, threadId, readBody, json, res }) => {
    if (path !== "/api/internal/execution-advice" || method !== "POST") return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    const parsed = requestSchema.safeParse(await readBody());
    if (!parsed.success) return json(res, 400, { error: "Supply a task between 1 and 2000 characters." });
    const current = deps.current(sender.id, threadId);
    if (!current) return json(res, 404, { error: "no such conversation" });
    const wholeDog = deps.wholeDogHistory(threadId);
    const advice = { historyVisibility: wholeDog ? "own_dog" : "current_thread", ...executionAdvice({ task: parsed.data.task, current, candidates: await deps.candidates(), rows: deps.rows().filter((row) => row.botId === sender.id && (wholeDog || row.threadId === threadId)), now: deps.now?.() ?? Date.now() }) };
    return json(res, 200, advice);
  };
}
