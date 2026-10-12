import type { IncomingMessage, ServerResponse } from "node:http";
import type { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";

export const PASS: unique symbol = Symbol("route.pass");

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  auth: RequestAuth;
  json: typeof json;
  readBody: typeof readBody;
}

export type RouteHandler = (ctx: RouteContext) => Promise<typeof PASS | void>;

export const ROUTES: RouteHandler[] = [];

export async function dispatchRoutes(routes: readonly RouteHandler[], ctx: RouteContext): Promise<boolean> {
  for (const route of routes) {
    const out = await route(ctx);
    if (out !== PASS || ctx.res.headersSent || ctx.res.writableEnded) return true;
  }
  return false;
}
