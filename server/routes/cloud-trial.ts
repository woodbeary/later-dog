import { ComputersApiError, trialInUse } from "../laterdog/cloud-computers.ts";
import { cancelPlan, endTrial, startPlan, startTrial, trialStatus, type PlanCheckout, type TrialOptions, type TrialStatus } from "../laterdog/cloud-trial.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CloudTrialRouteDeps extends TrialOptions {
  changed(): void;
}

const ACTIONS: Record<string, (options: TrialOptions) => Promise<TrialStatus>> = { GET: trialStatus, POST: startTrial, DELETE: endTrial };
const PLAN_ACTIONS: Record<string, (options: TrialOptions) => Promise<PlanCheckout>> = { POST: startPlan, DELETE: cancelPlan };

export function createCloudTrialRoutes(deps: CloudTrialRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== "/api/computers/trial" && path !== "/api/computers/plan") return PASS;
    res.setHeader("cache-control", "private, no-store");
    const table: Record<string, (options: TrialOptions) => Promise<PlanCheckout>> = path === "/api/computers/plan" ? PLAN_ACTIONS : ACTIONS;
    const action = Object.hasOwn(table, method) ? table[method] : undefined;
    if (!action) {
      res.setHeader("allow", path === "/api/computers/plan" ? "POST, DELETE" : "GET, POST, DELETE");
      return json(res, 405, { error: "method not allowed" });
    }
    const before = trialInUse();
    try {
      return json(res, 200, await action(deps));
    } catch (error) {
      if (error instanceof ComputersApiError) return json(res, 503, { error: error.message });
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status === "number" && status >= 400 && status < 500) return json(res, status, { error: (error as Error).message });
      throw error;
    } finally {
      if (trialInUse() !== before) deps.changed();
    }
  };
}
