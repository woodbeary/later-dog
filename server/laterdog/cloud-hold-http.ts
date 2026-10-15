import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { CloudHold, HeldRoutines } from "./cloud-hold.ts";
import type { RequestAuth } from "../request-auth.ts";

export const CLOUD_HOLD_PATH = "/api/cloud-hold";

export function createCloudHoldRoutes(options: {
  hold: CloudHold;
  routines: () => HeldRoutines | null;
  readBody: (req: IncomingMessage, limit?: number) => Promise<unknown>;
}) {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  return async (req: IncomingMessage, res: ServerResponse, path: string, auth: RequestAuth): Promise<boolean> => {
    if (path !== CLOUD_HOLD_PATH) return false;
    if (!auth.scopes.includes("admin")) { json(res, 403, { error: "Only the owner can change this." }); return true; }
    const method = req.method ?? "GET";
    if (method === "GET") { json(res, 200, { held: options.hold.held }); return true; }
    if (method !== "POST") { json(res, 405, { error: "Unsupported method." }); return true; }
    const parsed = z.object({ held: z.boolean() }).safeParse(await options.readBody(req, 1024));
    if (!parsed.success) { json(res, 400, { error: "Invalid request." }); return true; }
    json(res, 200, parsed.data.held ? options.hold.hold(options.routines()) : options.hold.release(options.routines()));
    return true;
  };
}
