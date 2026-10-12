
const READ_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT"]);

interface ScopedCall {
  slug: string;
}

export type ConnectorScope = "read" | "write";

export interface ConnectorScopes {
  apps: Record<string, ConnectorScope>;
}

const TOOLKIT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function toolkitOf(slug: string): string {
  const cut = slug.indexOf("_");
  return (cut > 0 ? slug.slice(0, cut) : slug).toLowerCase();
}

export function isReadOnlyAction(slug: string, toolkit?: string): boolean {
  if (slug === "COMPOSIO_PROXY_EXECUTE") return false;
  const cut = toolkit ? toolkit.length : slug.indexOf("_");
  const action = cut > 0 ? slug.slice(cut + 1) : "";
  const first = action.toUpperCase().split(/[^A-Z0-9]+/).find(Boolean);
  return first !== undefined && READ_VERBS.has(first);
}

export function normalizeConnectorScopes(value: unknown): ConnectorScopes | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as { apps?: unknown }).apps;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const apps: Record<string, ConnectorScope> = Object.create(null);
  for (const [key, scope] of Object.entries(raw as Record<string, unknown>)) {
    const slug = key.trim().toLowerCase();
    if (!TOOLKIT_SLUG.test(slug)) return null;
    if (scope !== "read" && scope !== "write") return null;
    apps[slug] = scope;
  }
  return { apps };
}

export type ConnectorAccess =
  | { ok: true }
  | { ok: false; slug: string; toolkit: string; reason: "app" | "write" };

export function connectorAccessDecision(scopes: ConnectorScopes | undefined, calls: ScopedCall[], toolkits: readonly string[] = []): ConnectorAccess {
  if (!scopes) return { ok: true };
  for (const call of calls) {
    const toolkit = toolkits.filter(candidate => call.slug.startsWith(candidate.toUpperCase() + "_"))
      .sort((a, b) => b.length - a.length)[0] ?? toolkitOf(call.slug);
    const scope = call.slug === "COMPOSIO_PROXY_EXECUTE" || !Object.hasOwn(scopes.apps, toolkit) ? undefined : scopes.apps[toolkit];
    if (!scope) return { ok: false, slug: call.slug, toolkit, reason: "app" };
    if (scope === "read" && !isReadOnlyAction(call.slug, toolkit)) return { ok: false, slug: call.slug, toolkit, reason: "write" };
  }
  return { ok: true };
}

export function describeConnectorScopes(scopes: ConnectorScopes | undefined): string {
  if (!scopes) return "";
  const entries = Object.entries(scopes.apps);
  if (entries.length === 0) return " This bot has been given no connected apps; do not try to use any.";
  const listed = entries
    .map(([slug, scope]) => `${slug} (${scope === "read" ? "read only" : "read and write"})`)
    .join(", ");
  return ` This bot may use only these connected apps: ${listed}. Do not try others, and do not write to a read-only one.`;
}
