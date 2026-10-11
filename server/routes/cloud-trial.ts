import { ComputersApiError, trialInUse } from "../laterdog/cloud-computers.ts";
import { endTrial, startTrial, trialStatus, type TrialOptions, type TrialStatus } from "../laterdog/cloud-trial.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CloudTrialRouteDeps extends TrialOptions {
  changed(): void;
}

const ACTIONS: Record<string, (options: TrialOptions) => Promise<TrialStatus>> = { GET: trialStatus, POST: startTrial, DELETE: endTrial };

export function createCloudTrialRoutes(deps: CloudTrialRouteDeps): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (path !== "/api/computers/trial") return PASS;
    res.setHeader("cache-control", "private, no-store");
    const action = Object.hasOwn(ACTIONS, method) ? ACTIONS[method] : undefined;
    if (!action) {
      res.setHeader("allow", "GET, POST, DELETE");
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
