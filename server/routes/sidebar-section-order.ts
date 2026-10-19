import { z } from "zod";
import { PASS, type RouteHandler } from "./table.ts";

export const SIDEBAR_SECTION_ORDER_PATH = "/api/sidebar-sections/order";

const orderSchema = z.object({ sections: z.array(z.string().trim().min(1).max(60)).max(200) }).strict();

export interface SidebarSectionOrderDeps {
  order(sections: readonly string[]): string[];
}

export function createSidebarSectionOrderRoutes(deps: SidebarSectionOrderDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path !== SIDEBAR_SECTION_ORDER_PATH) return PASS;
    if (method !== "PUT") return json(res, 405, { error: "method_not_allowed" });
    const parsed = orderSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Provide the section names in their new order" });
    return json(res, 200, { sections: deps.order(parsed.data.sections) });
  };
}
