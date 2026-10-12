import { CONNECTOR_SLUG_PATTERN, CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "../shared/wire.ts";
import { serviceSlugFor, serviceSlugForCandidates } from "./connector-verdict.ts";

export const CONNECTOR_ALLOWED_TOOLS_ENV = "LATERDOG_CONNECTOR_ALLOWED_TOOLS";

export const CONNECTOR_SERVICE_SLUGS_ENV = "LATERDOG_CONNECTOR_SERVICE_SLUGS";

export const CONNECTOR_ALLOWED_TOOLS_MAX_BYTES = 32 * 1024;

export const CONNECTOR_SERVICE_SLUGS_MAX_BYTES = 32 * 1024;

export const CONNECTOR_META_TOOLS: readonly string[] = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
];

const CONNECTION_TOOL_SUFFIXES = ["_MANAGE_CONNECTIONS", "_WAIT_FOR_CONNECTIONS"];

export function serializeConnectorAllowedTools(
  grants: Record<string, ConnectorToolGrant>,
): { env?: string; oversized: boolean } {
  const env = JSON.stringify(grants);
  if (Buffer.byteLength(env, "utf8") > CONNECTOR_ALLOWED_TOOLS_MAX_BYTES) return { oversized: true };
  return { env, oversized: false };
}

export function serializeConnectorServiceSlugs(
  slugs: readonly string[],
): { env?: string; oversized: boolean } {
  const unique = [...new Set(slugs.filter((slug) => CONNECTOR_SLUG_PATTERN.test(slug)))];
  if (!unique.length) return { oversized: false };
  const env = JSON.stringify(unique);
  if (Buffer.byteLength(env, "utf8") > CONNECTOR_SERVICE_SLUGS_MAX_BYTES) return { oversized: true };
  return { env, oversized: false };
}

export function parseConnectorAllowedToolsEnv(raw: string | undefined): Record<string, ConnectorToolGrant> | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const grants: Record<string, ConnectorToolGrant> = {};
  for (const [slug, grant] of Object.entries(value as Record<string, unknown>)) {
    if (!CONNECTOR_SLUG_PATTERN.test(slug)) return null;
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) return null;
    const tools = (grant as { tools?: unknown }).tools;
    if (tools === "*") {
      grants[slug] = { tools: "*" };
      continue;
    }
    if (!Array.isArray(tools) || tools.length === 0) return null;
    if (!tools.every((tool): tool is string => typeof tool === "string" && CONNECTOR_TOOL_NAME_PATTERN.test(tool))) {
      return null;
    }
    grants[slug] = { tools };
  }
  return grants;
}

export function parseConnectorServiceSlugsEnv(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.every((slug): slug is string => typeof slug === "string" && CONNECTOR_SLUG_PATTERN.test(slug))
    ? value
    : [];
}

export function connectorToolAdvertised(
  name: string,
  grants: Record<string, ConnectorToolGrant>,
  candidates: readonly string[] = [],
): boolean {
  if (Object.keys(grants).length > 0 && CONNECTOR_META_TOOLS.includes(name)) return true;
  const service = serviceSlugForCandidates(name, candidates) ?? serviceSlugFor(name);
  const grant = service === null ? undefined : grants[service];
  if (!grant) return false;
  if (grant.tools === "*") return true;
  if (grant.tools.includes(name)) return true;
  return CONNECTION_TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function filterToolsListFrame(
  frame: Record<string, unknown>,
  grants: Record<string, ConnectorToolGrant>,
  candidates: readonly string[] = [],
): Record<string, unknown> {
  const result = frame.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return frame;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return frame;
  const kept = tools.filter((tool) => {
    const name = tool && typeof tool === "object" && !Array.isArray(tool)
      ? (tool as { name?: unknown }).name
      : undefined;
    return typeof name === "string" ? connectorToolAdvertised(name, grants, candidates) : true;
  });
  return { ...frame, result: { ...(result as Record<string, unknown>), tools: kept } };
}
