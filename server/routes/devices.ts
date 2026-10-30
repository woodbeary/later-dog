import { fitsOnOneLine } from "../../shared/bot-profile.ts";
import type { SessionRegistry } from "../sessions.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const DEVICE_LABEL_CHARS = 60;
const SESSION_PATH = /^\/api\/auth\/sessions\/([\w-]+)$/;

export function deviceLabel(raw: unknown): string | null {
  const label = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return label && label.length <= DEVICE_LABEL_CHARS && fitsOnOneLine(label) ? label : null;
}

export function createDeviceRoutes(deps: { sessions: Pick<SessionRegistry, "rename"> }): RouteHandler {
  return async ({ req, res, method, path, json, readBody }) => {
    const m = SESSION_PATH.exec(path);
    if (!m || method !== "PATCH") return PASS;
    const label = deviceLabel((await readBody(req, 4_096))?.label);
    if (!label) return json(res, 400, { error: `Name the device in ${DEVICE_LABEL_CHARS} characters or fewer.` });
    const session = deps.sessions.rename(m[1]!, label);
    return session ? json(res, 200, { session }) : json(res, 404, { error: "That device is no longer signed in." });
  };
}
