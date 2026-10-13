import { describe, expect, it } from "vitest";
import { parsePairingGrant, pairingSignature, signedPairingRequest } from "../../deploy/laterdog/home/src/pairing.ts";
import { cloudPairingSignature, createCloudPairing } from "../cloud-home.ts";

const SECRET = "Q3e8bH2nK9vL4pX7sT1yW6zA0cF5dG8jM2kN4qR7uV9";

function fakeSessions() {
  const opened: Array<{ scopes: string[]; label: string; ttlMs: number }> = [];
  return {
    opened,
    sessions: {
      attemptAllowed: () => ({ ok: true as const, retryAfterMs: 0 }),
      noteFailure: () => undefined,
      clearFailures: () => undefined,
      openPairing: (input: { scopes: string[]; label: string; ttlMs: number }) => {
        opened.push(input);
        return { code: "ABCDEFGHJKLM", credential: "laterdog_pair_0123456789abcdefghij", expiresAt: Date.now() + input.ttlMs };
      },
    },
  };
}

describe("the Cloud home service signs pairing requests the home accepts", () => {
  it("signs exactly like the home server checks", async () => {
    const body = JSON.stringify({ label: "later.dog for iPhone", ttlSeconds: 300 });
    const ours = await pairingSignature(SECRET, "1790000000", "nonce-0123456789abcdef", body);
    expect(ours).toBe(cloudPairingSignature(SECRET, "1790000000", "nonce-0123456789abcdef", Buffer.from(body)));
  });

  it("is accepted by the home server's own pairing handler", async () => {
    const { sessions, opened } = fakeSessions();
    const pairing = createCloudPairing({ secret: SECRET, sessions: sessions as never });
    const request = await signedPairingRequest("https://h0123456789abcdef01234567-home.later.dog", SECRET, { label: "later.dog for iPhone", ttlSeconds: 300 });
    const result = pairing.handle({
      timestamp: request.headers.get("x-laterdog-cloud-timestamp") ?? undefined,
      nonce: request.headers.get("x-laterdog-cloud-nonce") ?? undefined,
      signature: request.headers.get("x-laterdog-cloud-signature") ?? undefined,
      body: Buffer.from(await request.text()),
      source: "test",
    });
    expect(result.status).toBe(200);
    expect(opened[0]).toMatchObject({ scopes: ["admin", "client"], label: "later.dog for iPhone", ttlMs: 300_000 });
    expect(parsePairingGrant(result.body, Date.now())).toMatchObject({ code: "ABCD-EFGH-JKLM" });
  });

  it("is refused when signed with another home's secret", async () => {
    const { sessions } = fakeSessions();
    const pairing = createCloudPairing({ secret: SECRET, sessions: sessions as never });
    const request = await signedPairingRequest("https://h0123456789abcdef01234567-home.later.dog", `${SECRET.slice(1)}x`, { label: "x", ttlSeconds: 300 });
    const result = pairing.handle({
      timestamp: request.headers.get("x-laterdog-cloud-timestamp") ?? undefined,
      nonce: request.headers.get("x-laterdog-cloud-nonce") ?? undefined,
      signature: request.headers.get("x-laterdog-cloud-signature") ?? undefined,
      body: Buffer.from(await request.text()),
      source: "test",
    });
    expect(result).toEqual({ status: 401, body: { error: "invalid_signature" } });
  });

  it("accepts only well-formed, short-lived grants", () => {
    const now = Date.now();
    expect(parsePairingGrant({ code: "ABCD-EFGH-JKLM", credential: "laterdog_pair_0123456789abcdefghij", expiresAt: now + 60_000 }, now)).not.toBeNull();
    expect(parsePairingGrant({ code: "ABCD-EFGH-JKLM", credential: "laterdog_pair_0123456789abcdefghij", expiresAt: now + 60 * 60_000 }, now)).toBeNull();
    expect(parsePairingGrant({ code: "abcd", credential: "x", expiresAt: now + 1000 }, now)).toBeNull();
  });
});
