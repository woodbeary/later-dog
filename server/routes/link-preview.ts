import { LinkPreviews } from "../laterdog/link-preview.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createLinkPreviewRoutes(previews = new LinkPreviews()): RouteHandler {
  return async ({ res, method, path, url, json }) => {
    if (method !== "GET" || path !== "/api/link-preview") return PASS;
    const target = url.searchParams.get("url") ?? "";
    if (!target || target.length > 2_000) return json(res, 400, { error: "url must be an https web address" });
    return json(res, 200, { preview: await previews.preview(target) });
  };
}
