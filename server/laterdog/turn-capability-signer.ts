import { bearerCapability, validCapabilityClaims, type SignedCapabilityKind } from "../../shared/signed-capability.ts";
import { capabilitySecret, signCapabilitySync, verifyCapabilitySync } from "./signed-capability-node.ts";

export interface TurnCapabilityGrant {
  dog: string;
  chat: string;
  generation: string;
  kind: SignedCapabilityKind;
}

export interface TurnCapabilitySigner {
  sign(grant: TurnCapabilityGrant, lifetimeMs: number): string | null;
  presented(header: string): string | null;
  genuine(token: string): boolean;
}

export function turnCapabilitySigner(options: { home: string; bootstrapSecret: string; now?: () => number }): TurnCapabilitySigner {
  const secret = capabilitySecret(options.bootstrapSecret);
  const now = options.now ?? Date.now;
  return {
    sign(grant, lifetimeMs) {
      const issuedAt = now();
      const claims = { home: options.home, ...grant, issuedAt, expiresAt: issuedAt + lifetimeMs };
      return validCapabilityClaims(claims) ? signCapabilitySync(secret, claims) : null;
    },
    presented(header) {
      return bearerCapability(header);
    },
    genuine(token) {
      return verifyCapabilitySync(secret, token, { home: options.home, now: now() }).ok;
    },
  };
}
