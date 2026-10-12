import { CONNECTOR_TOOL_NAME_PATTERN, type ConnectorToolGrant } from "../shared/wire.ts";

export const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

export type ConnectorCall =
  | { kind: "passthrough" }
  | { kind: "tools"; invoked: string; names: string[] }
  | { kind: "unrecognized"; invoked: string; reason: string };

export interface ConnectorDenial {
  tool: string;
  service: string | null;
  onGrantedService: boolean;
}

export interface ConnectorVerdict {
  allowed: boolean;
  legacy: boolean;
  denials: ConnectorDenial[];
  rule: string;
}

export function serviceSlugFor(tool: string): string | null {
  const underscore = tool.indexOf("_");
  if (underscore <= 0) return null;
  return tool.slice(0, underscore).toLowerCase();
}

export function serviceSlugForCandidates(tool: string, candidates: readonly string[]): string | null {
  let match: string | null = null;
  for (const candidate of candidates) {
    if (tool.startsWith(candidate.toUpperCase() + "_") && (match === null || candidate.length > match.length)) {
      match = candidate;
    }
  }
  return match;
}

export function connectorCallFromFrame(payload: unknown): ConnectorCall {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { kind: "passthrough" };
  const frame = payload as { method?: unknown; params?: unknown };
  if (frame.method !== "tools/call") return { kind: "passthrough" };
  const params = frame.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { kind: "unrecognized", invoked: "tools/call", reason: "the call carried no params object" };
  }
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string" || !name) {
    return { kind: "unrecognized", invoked: "tools/call", reason: "the call named no tool" };
  }
  if (name === COMPOSIO_MULTI_EXECUTE_TOOL) {
    return multiExecuteCall(name, (params as { arguments?: unknown }).arguments);
  }
  if (name.startsWith("COMPOSIO_")) return { kind: "passthrough" };
  if (name.endsWith("_MANAGE_CONNECTIONS") || name.endsWith("_WAIT_FOR_CONNECTIONS")) {
    return { kind: "passthrough" };
  }
  if (!CONNECTOR_TOOL_NAME_PATTERN.test(name)) {
    return { kind: "unrecognized", invoked: name, reason: "the tool name is not a Composio tool name" };
  }
  return { kind: "tools", invoked: name, names: [name] };
}

function multiExecuteCall(invoked: string, args: unknown): ConnectorCall {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { kind: "unrecognized", invoked, reason: "the arguments were not an object" };
  }
  const tools = (args as { tools?: unknown }).tools;
  const singleSlug = (args as { tool_slug?: unknown }).tool_slug;
  if (Array.isArray(tools)) {
    if (tools.length === 0) {
      return { kind: "unrecognized", invoked, reason: "the tools list was empty" };
    }
    const names: string[] = [];
    for (const item of tools) {
      const slug = item && typeof item === "object" && !Array.isArray(item)
        ? (item as { tool_slug?: unknown }).tool_slug
        : undefined;
      if (typeof slug !== "string" || !slug) {
        return { kind: "unrecognized", invoked, reason: "an entry in the tools list named no tool_slug" };
      }
      names.push(slug);
    }
    return { kind: "tools", invoked, names };
  }
  if (typeof singleSlug === "string" && singleSlug) {
    return { kind: "tools", invoked, names: [singleSlug] };
  }
  return { kind: "unrecognized", invoked, reason: "the arguments named no tools to execute" };
}

export function evaluateConnectorTools(
  names: string[],
  grants: Record<string, ConnectorToolGrant> | undefined,
  candidates: readonly string[] = [],
): ConnectorVerdict {
  if (grants === undefined) {
    return { allowed: true, legacy: true, denials: [], rule: "composio" };
  }
  const denials: ConnectorDenial[] = [];
  let rule = "";
  for (const tool of new Set(names)) {
    const service = serviceSlugForCandidates(tool, candidates) ?? serviceSlugFor(tool);
    const grant = service !== null && Object.hasOwn(grants, service)
      ? grants[service]
      : undefined;
    if (grant && (grant.tools === "*" || grant.tools.includes(tool))) {
      if (!rule) rule = "connectorTools." + service;
      continue;
    }
    denials.push({ tool, service, onGrantedService: Boolean(grant) });
  }
  return { allowed: denials.length === 0, legacy: false, denials, rule };
}

export function connectorRefusalText(denials: ConnectorDenial[]): string {
  const named = denials.map((denial) => '"' + denial.tool + '"').join(", ");
  const one = denials.length === 1;
  return [
    named + " " + (one ? "is" : "are") + " not granted to this bot.",
    "This call was not performed.",
    "Ask the person to grant " + (one ? "it" : "these tools") + " in later.dog if they want " + (one ? "it" : "them") + " run.",
  ].join(" ");
}

export function connectorUnrecognizedText(invoked: string, reason: string): string {
  return [
    "A " + invoked + " call arrived in a shape later.dog could not read (" + reason + "), so it was not performed.",
    "Send a well-formed call that names the tools to execute.",
    "Ask the person to grant any tool this bot needs.",
  ].join(" ");
}
