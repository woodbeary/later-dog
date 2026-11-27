import { createHmac, timingSafeEqual } from "node:crypto";
import {
  CAPABILITY_KEY_LABEL,
  SIGNED_CAPABILITY_PREFIX,
  admitCapability,
  capabilityParts,
  encodeCapabilityPayload,
  type CapabilityCheck,
  type CapabilityExpectation,
  type SignedCapabilityClaims,
} from "../../shared/signed-capability.ts";

export function capabilitySecret(bootstrapSecret: string): Buffer {
  if (!bootstrapSecret) throw new Error("missing capability secret");
  return createHmac("sha256", bootstrapSecret).update(CAPABILITY_KEY_LABEL).digest();
}

export function signCapabilitySync(secret: Buffer, claims: SignedCapabilityClaims): string {
  const signed = `${SIGNED_CAPABILITY_PREFIX}${encodeCapabilityPayload(claims)}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
}

export function verifyCapabilitySync(secret: Buffer, token: string, expect: CapabilityExpectation): CapabilityCheck {
  const parts = capabilityParts(token);
  if (!parts) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", secret).update(parts.signed).digest();
  if (!timingSafeEqual(expected, Buffer.from(parts.mac))) return { ok: false, reason: "forged" };
  return admitCapability(parts.claims, expect);
}
