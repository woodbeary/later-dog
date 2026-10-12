
export type CompanionEndpointKind = "hosted" | "tailnet" | "lan" | "bonjour";

export interface CompanionEndpoint {
  url: string;
  kind: CompanionEndpointKind;
  priority: number;
}

export interface PhonePairingLinkOptions {
  address: string;
  port?: number;
  token: string;
  code?: string;
  name?: string;
  hosts?: string[];
  endpoints?: CompanionEndpoint[];
  secretPublicKey?: string;
}

export const MAX_PAIRING_HOSTS = 8;

const ENDPOINT_KINDS = new Set<CompanionEndpointKind>(["hosted", "tailnet", "lan", "bonjour"]);

export function qrEndpoints(endpoints: CompanionEndpoint[] | undefined): CompanionEndpoint[] {
  const seen = new Set<string>();
  const valid: CompanionEndpoint[] = [];

  for (const endpoint of endpoints ?? []) {
    if (
      !endpoint ||
      !ENDPOINT_KINDS.has(endpoint.kind) ||
      !Number.isInteger(endpoint.priority) ||
      endpoint.priority < 0 ||
      endpoint.priority > 1_000_000
    ) {
      continue;
    }

    try {
      const parsed = new URL(endpoint.url);
      const expectedProtocol = endpoint.kind === "hosted" ? "https:" : "http:";
      const explicitPort = parsed.port ? Number(parsed.port) : null;
      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
      if (
        parsed.protocol !== expectedProtocol ||
        hostname.split(".").includes("") ||
        (endpoint.kind === "tailnet" && !hostname.endsWith(".ts.net")) ||
        (explicitPort !== null && (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65_535)) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash ||
        seen.has(parsed.origin)
      ) {
        continue;
      }
      seen.add(parsed.origin);
      valid.push({ url: parsed.origin, kind: endpoint.kind, priority: endpoint.priority });
    } catch {}
  }

  return valid.sort((left, right) => left.priority - right.priority).slice(0, MAX_PAIRING_HOSTS);
}

function encodeEndpoints(endpoints: CompanionEndpoint[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(endpoints));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function validSecretPublicKey(value: string | undefined): string | null {
  if (!value || !/^[A-Za-z0-9_-]{87}$/.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
    const decoded = atob(base64);
    if (decoded.length !== 65 || decoded.charCodeAt(0) !== 4) return null;
    let binary = "";
    for (let index = 0; index < decoded.length; index += 1) binary += decoded[index];
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") === value
      ? value
      : null;
  } catch {
    return null;
  }
}

function linkAddress(address: string, port: number | undefined): string | null {
  const value = address.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const authority = value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
  return `${authority}:${port}`;
}

export function phonePairingLink({
  address,
  port,
  token,
  code,
  name,
  hosts,
  endpoints,
  secretPublicKey,
}: PhonePairingLinkOptions): string | null {
  const dial = linkAddress(address, port);
  if (!dial || !/^laterdog_pair_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  if (code !== undefined && !/^\d{6}$/.test(code)) return null;

  const fields: Array<[string, string]> = [["address", dial], ["token", token]];
  if (code !== undefined) fields.push(["code", code]);
  if (name?.trim()) fields.push(["name", name.trim()]);
  const candidates = (hosts ?? [])
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate && !/[\s/?#,[\]]/.test(candidate))
    .slice(0, MAX_PAIRING_HOSTS);
  if (candidates.length) fields.push(["hosts", candidates.join(",")]);
  const routes = qrEndpoints(endpoints);
  if (routes.length) fields.push(["endpoints", encodeEndpoints(routes)]);
  const secretKey = validSecretPublicKey(secretPublicKey);
  if (secretKey) fields.push(["secretKey", secretKey]);

  return `laterdog://pair?${fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
}
