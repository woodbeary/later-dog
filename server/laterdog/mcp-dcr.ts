export type TokenAuthMethod = "none" | "client_secret_post" | "client_secret_basic";
type SecretMethod = Exclude<TokenAuthMethod, "none">;

export interface DynamicClient {
  id: string;
  secret?: string;
  method: TokenAuthMethod;
}

const isSecretMethod = (value: unknown): value is SecretMethod => value === "client_secret_basic" || value === "client_secret_post";

export function secretMethod(supported: readonly string[] | undefined, offered?: unknown): SecretMethod {
  if (isSecretMethod(offered) && (!supported || supported.includes(offered))) return offered;
  return !supported || supported.includes("client_secret_basic") || !supported.includes("client_secret_post")
    ? "client_secret_basic"
    : "client_secret_post";
}

export function registrationAttempts(supported: readonly string[] | undefined): TokenAuthMethod[] {
  if (!supported || supported.includes("none") || !supported.some(isSecretMethod)) return ["none"];
  return ["none", secretMethod(supported)];
}

export function registrationRequest(redirectUri: string, method: TokenAuthMethod) {
  return {
    client_name: "later.dog",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
  };
}

export function registeredClient(body: unknown, supported: readonly string[] | undefined): DynamicClient | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const answer = body as Record<string, unknown>;
  const id = answer.client_id;
  if (typeof id !== "string" || !id) return null;
  const secret = answer.client_secret;
  if (typeof secret !== "string" || !secret || answer.token_endpoint_auth_method === "none") return { id, method: "none" };
  return { id, secret, method: secretMethod(supported, answer.token_endpoint_auth_method) };
}
