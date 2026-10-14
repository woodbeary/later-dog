import type { IncomingMessage, ServerResponse } from "node:http";
import type { json } from "../harness/http.ts";
import { HOME_ACTIVITY_PATH, type createHomeActivity } from "../laterdog/home-activity.ts";

export type HomeActivityRoute = (req: IncomingMessage, res: ServerResponse, path: string, method: string, send: typeof json) => boolean;

export function createHomeActivityRoute(activity: ReturnType<typeof createHomeActivity>): HomeActivityRoute {
  return (req, res, path, method, send) => {
    if (path !== HOME_ACTIVITY_PATH) return false;
    res.setHeader("cache-control", "no-store");
    if (method !== "GET") {
      send(res, 405, { error: "method_not_allowed" });
      return true;
    }
    const header = (name: string) => { const value = req.headers[name]; return typeof value === "string" ? value : undefined; };
    const result = activity.handle({ timestamp: header("x-laterdog-cloud-timestamp"), nonce: header("x-laterdog-cloud-nonce"), signature: header("x-laterdog-cloud-signature") });
    send(res, result.status, result.body);
    return true;
  };
}
