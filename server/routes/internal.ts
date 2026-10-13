import type { IncomingMessage, ServerResponse } from "node:http";
import type { json } from "../harness/http.ts";
import type { BotRecord } from "../store.ts";
import { PASS } from "./table.ts";

export interface InternalRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  json: typeof json;
  sender: BotRecord;
  threadId: string;
  readBody(): Promise<any>;
}

export type InternalRouteHandler = (ctx: InternalRouteContext) => Promise<typeof PASS | void>;

export const INTERNAL_ROUTES: InternalRouteHandler[] = [];

export async function dispatchInternalRoutes(routes: readonly InternalRouteHandler[], ctx: InternalRouteContext): Promise<boolean> {
  for (const route of routes) {
    const out = await route(ctx);
    if (out !== PASS || ctx.res.headersSent || ctx.res.writableEnded) return true;
  }
  return false;
}
