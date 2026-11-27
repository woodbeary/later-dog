import {
  bearerCapability,
  capabilityKey,
  signedCapabilityKinds,
  verifyCapability,
  type SignedCapabilityKind,
} from "../../../../shared/signed-capability.ts";
import { bootstrapSecret } from "./identity.ts";

export const MOVED_PREFIX = "/api/internal/";
export const CAPABILITY_CLAIMS_HEADER = "x-laterdog-capability";
const HOME_ROW = /^(?:\*|[a-z0-9-]{1,64})$/;
const PREFIX = /^\/api\/internal\/[a-z0-9/_-]*$/;

export interface EdgeRouteRow {
  home: string;
  prefix: string;
  kinds: readonly SignedCapabilityKind[];
}

export type EdgeRoutes = readonly EdgeRouteRow[];

export interface EdgeEnv {
  HOME_SECRET: string;
  EDGE_ROUTES?: string;
  COORDINATOR?: Pick<Fetcher, "fetch">;
}

export interface EdgeDeps {
  routes: EdgeRoutes;
  home: string;
  key: () => Promise<CryptoKey>;
  coordinator: Pick<Fetcher, "fetch"> | undefined;
  now?: () => number;
}

function validRow(value: unknown): value is EdgeRouteRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.home === "string" && HOME_ROW.test(row.home) &&
    typeof row.prefix === "string" && PREFIX.test(row.prefix) && !row.prefix.includes("//") &&
    Array.isArray(row.kinds) && row.kinds.length > 0 &&
    row.kinds.every((kind) => (signedCapabilityKinds as readonly unknown[]).includes(kind));
}

export function parseEdgeRoutes(raw: string | undefined): EdgeRoutes {
  if (!raw?.trim()) return [];
  try {
    const rows: unknown = JSON.parse(raw);
    return Array.isArray(rows) && rows.every(validRow) ? rows : [];
  } catch {
    return [];
  }
}

function prefixCovers(prefix: string, pathname: string): boolean {
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function movedRoute(routes: EdgeRoutes, home: string, pathname: string): EdgeRouteRow | null {
  if (!pathname.startsWith(MOVED_PREFIX)) return null;
  let best: EdgeRouteRow | null = null;
  for (const row of routes) {
    if (row.home !== "*" && row.home !== home) continue;
    if (!prefixCovers(row.prefix, pathname)) continue;
    const better = !best || row.prefix.length > best.prefix.length || (row.prefix.length === best.prefix.length && best.home === "*");
    if (better) best = row;
  }
  return best;
}

function refuse(status: number, error: string, extra: HeadersInit = {}): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store", ...extra } });
}

export async function routeAtEdge(request: Request, deps: EdgeDeps): Promise<Response | null> {
  if (!deps.coordinator || deps.routes.length === 0) return null;
  const url = new URL(request.url);
  const row = movedRoute(deps.routes, deps.home, url.pathname);
  if (!row) return null;
  const token = bearerCapability(request.headers.get("authorization"));
  if (!token) return refuse(401, "signed_capability_required");
  const check = await verifyCapability(await deps.key(), token, { home: deps.home, now: (deps.now ?? Date.now)(), kinds: row.kinds });
  if (!check.ok) return refuse(check.reason === "wrong-kind" ? 403 : 401, `capability_${check.reason}`);
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.set(CAPABILITY_CLAIMS_HEADER, JSON.stringify(check.claims));
  try {
    return await deps.coordinator.fetch(new Request(request, { headers }));
  } catch {
    return refuse(503, "coordinator_unavailable", { "retry-after": "1" });
  }
}

const keys = new Map<string, Promise<CryptoKey>>();

export function edgeCapabilityKey(homeSecret: string, home: string): Promise<CryptoKey> {
  const held = keys.get(home);
  if (held) return held;
  const key = bootstrapSecret(homeSecret, home).then(capabilityKey);
  key.catch(() => keys.delete(home));
  keys.set(home, key);
  return key;
}

export function edgeDeps(env: EdgeEnv, home: string): EdgeDeps {
  return {
    routes: parseEdgeRoutes(env.EDGE_ROUTES),
    home,
    key: () => edgeCapabilityKey(env.HOME_SECRET, home),
    coordinator: env.COORDINATOR,
  };
}
