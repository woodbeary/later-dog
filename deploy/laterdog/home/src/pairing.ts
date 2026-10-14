import { base64url, hmacSha256, randomToken, sha256 } from "./encoding.ts";

export const CLOUD_PAIRING_PATH = "/api/cloud/pairing";
const CODE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const CREDENTIAL = /^laterdog_pair_[A-Za-z0-9_-]{16,200}$/;

export interface PairingGrant {
  code: string;
  credential: string;
  expiresAt: number;
}

export async function pairingSignature(secret: string, timestamp: string, nonce: string, body: string): Promise<string> {
  const bodyHash = base64url(await sha256(body));
  return base64url(await hmacSha256(secret, `v1\n${timestamp}\n${nonce}\nPOST\n${CLOUD_PAIRING_PATH}\n${bodyHash}`));
}

export async function signedPairingRequest(origin: string, secret: string, input: { label: string; ttlSeconds: number }, now = Date.now()): Promise<Request> {
  const body = JSON.stringify({ label: input.label, ttlSeconds: input.ttlSeconds });
  const timestamp = String(Math.floor(now / 1000));
  const nonce = randomToken(24);
  const signature = await pairingSignature(secret, timestamp, nonce, body);
  return new Request(`${origin}${CLOUD_PAIRING_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-laterdog-cloud-timestamp": timestamp,
      "x-laterdog-cloud-nonce": nonce,
      "x-laterdog-cloud-signature": `v1=${signature}`,
    },
    body,
  });
}

export function parsePairingGrant(input: unknown, now: number): PairingGrant | null {
  if (!input || typeof input !== "object") return null;
  const { code, credential, expiresAt } = input as Record<string, unknown>;
  if (typeof code !== "string" || !CODE.test(code)) return null;
  if (typeof credential !== "string" || !CREDENTIAL.test(credential)) return null;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 10 * 60_000) return null;
  return { code, credential, expiresAt };
}
