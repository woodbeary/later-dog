import { existsSync, lstatSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";

const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;
const FILE_LIMIT = 4_096;

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const zone = value.trim();
  if (zone !== value || zone.length > 64 || !(zone === "UTC" || ZONE_SHAPE.test(zone))) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function savedTimeZone(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_LIMIT) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { timeZone?: unknown };
    return isTimeZone(parsed.timeZone) ? parsed.timeZone : null;
  } catch {
    return null;
  }
}

export function applyTimeZone(zone: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isTimeZone(zone) || env.TZ === zone) return false;
  env.TZ = zone;
  return true;
}

export function restoreTimeZone(file: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const zone = savedTimeZone(file);
  if (zone) applyTimeZone(zone, env);
  return zone;
}

export interface TimeZoneDeps {
  file: string;
  allowed(auth: RequestAuth): boolean;
  changed(zone: string): void;
  env?: NodeJS.ProcessEnv;
}

export function createTimeZoneRoutes(deps: TimeZoneDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/time-zone") return PASS;
    if (method === "GET") return json(res, 200, { timeZone: currentTimeZone(), saved: savedTimeZone(deps.file) });
    if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
    if (!deps.allowed(auth)) return json(res, 403, { error: "Only the owner can change the home's time zone." });
    const body = await readBody(req, 1_024) as { timeZone?: unknown } | null;
    if (!isTimeZone(body?.timeZone)) return json(res, 400, { error: "Choose an IANA time zone such as America/Los_Angeles or UTC." });
    const zone = body.timeZone;
    writeFileAtomic(deps.file, JSON.stringify({ version: 1, timeZone: zone }), { mode: 0o600 });
    if (applyTimeZone(zone, deps.env)) deps.changed(zone);
    return json(res, 200, { timeZone: currentTimeZone(), saved: zone });
  };
}
