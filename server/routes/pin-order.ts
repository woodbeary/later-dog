import { z } from "zod";
import { PASS, type RouteHandler } from "./table.ts";

export const PIN_ORDER_PATH = "/api/bots/pin-order";

const orderSchema = z.object({ order: z.array(z.string().regex(/^[\w-]+$/)).max(500) }).strict();

export interface PinOrderDeps {
  order(ids: readonly string[]): string[];
}

export function createPinOrderRoutes(deps: PinOrderDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== PIN_ORDER_PATH) return PASS;
    if (method !== "PUT") return json(res, 405, { error: "method_not_allowed" });
    const parsed = orderSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Provide the pinned dogs' ids in their new order" });
    return json(res, 200, { order: deps.order(parsed.data.order) });
  };
}
