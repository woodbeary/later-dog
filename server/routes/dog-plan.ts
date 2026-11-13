import type { PlanItem, WirePlan } from "../../shared/dog-plan.ts";
import { parsePlanItems, planRecorded, type PlanCaller } from "../laterdog/dog-plan.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export const PLAN_PATH = "/api/internal/plan";
export const PLAN_CALLER_WAIT_MS = 1_500;

export const HELPER_PLAN_TEXT = "Not recorded: the plan belongs to the dog that talks to the person. Report your progress in your last message instead.";

export interface PlanRouteDeps {
  set(threadId: string, items: PlanItem[], botId: string): WirePlan;
  caller(toolUseId: string | undefined): Promise<PlanCaller>;
  changed(threadId: string, botId: string): void;
  active(capability: unknown): boolean;
}

export function createPlanRoute(deps: PlanRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, sender, threadId, capability, readBody }) => {
    if (method !== "POST" || path !== PLAN_PATH) return PASS;
    const body = await readBody();
    const parsed = parsePlanItems(body.items);
    if (!parsed.ok) return json(res, 400, { error: parsed.error });
    const toolUseId = typeof body.toolUseId === "string" && body.toolUseId ? body.toolUseId : undefined;
    if (await deps.caller(toolUseId) === "helper") return json(res, 200, { recorded: false, text: HELPER_PLAN_TEXT });
    if (!deps.active(capability)) throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 });
    const plan = deps.set(threadId, parsed.items, sender.id);
    deps.changed(threadId, sender.id);
    return json(res, 200, { recorded: true, plan, text: planRecorded(plan.items) });
  };
}
