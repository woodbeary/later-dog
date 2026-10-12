
export type OutboundPolicy = {
  policy: "ask" | "allow";
  dailyCap: number;
};

export const OUTBOUND_DEFAULT_CAP = 25;
const OUTBOUND_MAX_CAP = 1_000;

const SEND_VERBS = new Set([
  "SEND",
  "SENDS",
  "REPLY",
  "RESPOND",
  "FORWARD",
  "POST",
  "PUBLISH",
  "TWEET",
  "RETWEET",
  "BROADCAST",
  "INVITE",
  "SHARE",
  "REFUND",
  "CHARGE",
  "PAY",
  "PAYOUT",
  "TRANSFER",
]);

const CREATE_VERBS = new Set(["CREATE", "CREATION", "ADD", "NEW"]);
const SENT_NOUNS = new Set(["MESSAGE", "COMMENT", "POST", "EMAIL", "MAIL", "INVOICE", "PAYMENT", "REFUND", "REPLY", "TWEET", "DM"]);

const READ_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "READ", "FIND", "RETRIEVE", "LOOKUP", "DOWNLOAD", "VIEW", "CHECK", "COUNT"]);

function actionTokens(name: string): string[] {
  let action = name;
  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    action = rest.join("_");
    if (server === "composio") return actionTokens(action);
  } else if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name)) {
    action = name.slice(name.indexOf("_") + 1);
  }
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

export function isOutboundTool(name: string): boolean {
  if (name === "COMPOSIO_PROXY_EXECUTE") return true;
  const tokens = actionTokens(name);
  if (tokens.length === 0) return false;
  if (READ_VERBS.has(tokens[0])) return false;
  if (tokens.some((token) => SEND_VERBS.has(token))) return true;
  if (tokens.includes("DRAFT")) return false;
  return tokens.some((token) => CREATE_VERBS.has(token)) && tokens.some((token) => SENT_NOUNS.has(token));
}

export function normalizeOutboundPolicy(value: unknown): OutboundPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { policy, dailyCap } = value as { policy?: unknown; dailyCap?: unknown };
  if (policy !== "ask" && policy !== "allow") return null;
  if (dailyCap === undefined) return { policy, dailyCap: OUTBOUND_DEFAULT_CAP };
  if (typeof dailyCap !== "number" || !Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > OUTBOUND_MAX_CAP) return null;
  return { policy, dailyCap };
}

export const DEFAULT_OUTBOUND_POLICY: OutboundPolicy = { policy: "ask", dailyCap: OUTBOUND_DEFAULT_CAP };

export interface ConnectorCall {
  slug: string;
  arguments?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function connectorCallsIn(name: string, args: unknown): ConnectorCall[] {
  if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const tools = isRecord(args) && Array.isArray(args.tools) ? args.tools
      : isRecord(args) && typeof args.tool_slug === "string" ? [args] : [];
    if (!tools.length) return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
    const calls: ConnectorCall[] = [];
    for (const item of tools) {
      if (!isRecord(item)) return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
      const slug = [item.tool_slug, item.slug, item.name, item.tool].find((value) => typeof value === "string" && value);
      if (typeof slug !== "string") return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
      calls.push({ slug, ...(item.arguments !== undefined ? { arguments: item.arguments } : {}) });
    }
    return calls;
  }
  if (name === "COMPOSIO_REMOTE_WORKBENCH" || name === "COMPOSIO_REMOTE_BASH_TOOL") {
    return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
  }
  if (["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_WAIT_FOR_CONNECTIONS"].includes(name)) return [];
  if (name.startsWith("COMPOSIO_")) return [{ slug: "COMPOSIO_PROXY_EXECUTE", arguments: args }];
  return [{ slug: name, ...(args !== undefined ? { arguments: args } : {}) }];
}

export function outboundCallsIn(name: string, args: unknown): ConnectorCall[] {
  return connectorCallsIn(name, args).filter((call) => isOutboundTool(call.slug));
}
