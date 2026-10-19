export type Tier = "trial" | "home" | "plan";

export const TIERS: readonly Tier[] = ["trial", "home", "plan"];

export type GatewayMetadata = { user: string; tier: Tier };

export const GATEWAY_USER_HEX = 16;

export function gatewayMetadata(keySha256: string, tier: Tier): GatewayMetadata {
  return { user: keySha256.slice(0, GATEWAY_USER_HEX), tier };
}

export function gatewayId(env: Env): string {
  return env.AI_GATEWAY_ID?.trim() || "default";
}

export function gatewayOptions(env: Env, metadata?: GatewayMetadata) {
  return { gateway: { id: gatewayId(env), collectLog: false, ...(metadata ? { metadata } : {}) } };
}

export function withMetadata<T extends { headers: Record<string, unknown> }>(request: T, metadata: GatewayMetadata): T {
  return { ...request, headers: { ...request.headers, "cf-aig-metadata": JSON.stringify(metadata) } };
}
