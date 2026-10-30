const KEY_SHA256 = /^[0-9a-f]{64}$/;

export function ownerKeys(env: { OWNER_KEY_SHA256S?: string }): Set<string> {
  return new Set((env.OWNER_KEY_SHA256S ?? "").toLowerCase().split(/[\s,]+/).filter((key) => KEY_SHA256.test(key)));
}
