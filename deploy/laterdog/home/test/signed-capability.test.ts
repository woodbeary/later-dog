import { describe, expect, it } from "vitest";
import {
  SIGNED_CAPABILITY_PREFIX,
  bearerCapability,
  capabilityKey,
  signCapability,
  verifyCapability,
  type SignedCapabilityClaims,
} from "../../../../shared/signed-capability.ts";
import { capabilitySecret, signCapabilitySync, verifyCapabilitySync } from "../../../../server/laterdog/signed-capability-node.ts";

const NOW = 1_800_000_000_000;
const claims: SignedCapabilityClaims = {
  home: "h0123456789abcdef01234567",
  dog: "bot-7",
  chat: "thread-9",
  generation: "6f1c1f9e-1d7a-4d47-9a7e-1e0d2f3b4c5d",
  kind: "agents",
  issuedAt: NOW - 1_000,
  expiresAt: NOW + 60_000,
};
const expect_ = { home: claims.home, now: NOW };

function flipLast(text: string): string {
  return text.slice(0, -1) + (text.endsWith("A") ? "B" : "A");
}

describe("signed capabilities", () => {
  it("verifies a token it signed and returns its claims", async () => {
    const key = await capabilityKey("bootstrap-secret");
    const token = await signCapability(key, claims);
    expect(token.startsWith(SIGNED_CAPABILITY_PREFIX)).toBe(true);
    expect(await verifyCapability(key, token, expect_)).toEqual({ ok: true, claims });
  });

  it("refuses a token signed with another home's key", async () => {
    const token = await signCapability(await capabilityKey("other-secret"), claims);
    expect(await verifyCapability(await capabilityKey("bootstrap-secret"), token, expect_)).toEqual({ ok: false, reason: "forged" });
  });

  it("refuses a token whose claims were changed after signing", async () => {
    const key = await capabilityKey("bootstrap-secret");
    const token = await signCapability(key, claims);
    const [, payload, mac] = token.split(".");
    const widened = btoa(atob(payload.replace(/-/g, "+").replace(/_/g, "/")).replace('"k":"agents"', '"k":"turns"'))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyCapability(key, `${SIGNED_CAPABILITY_PREFIX}${widened}.${mac}`, expect_)).toEqual({ ok: false, reason: "forged" });
    expect(await verifyCapability(key, flipLast(token), expect_)).toMatchObject({ ok: false });
  });

  it("refuses expired, other-home and other-kind tokens", async () => {
    const key = await capabilityKey("bootstrap-secret");
    const token = await signCapability(key, claims);
    expect(await verifyCapability(key, token, { ...expect_, now: claims.expiresAt })).toEqual({ ok: false, reason: "expired" });
    expect(await verifyCapability(key, token, { ...expect_, home: "h999999999999999999999999" })).toEqual({ ok: false, reason: "wrong-home" });
    expect(await verifyCapability(key, token, { ...expect_, kinds: ["hooks"] })).toEqual({ ok: false, reason: "wrong-kind" });
  });

  it("refuses malformed tokens without throwing", async () => {
    const key = await capabilityKey("bootstrap-secret");
    const token = await signCapability(key, claims);
    for (const bad of ["", "random-token", `${token}.extra`, `${SIGNED_CAPABILITY_PREFIX}!!.??`, `${token}${"A".repeat(2048)}`,
      `${SIGNED_CAPABILITY_PREFIX}${btoa(JSON.stringify({ v: 2 }))}.${token.split(".")[2]}`]) {
      expect(await verifyCapability(key, bad, expect_)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("will not sign claims that could not be verified", async () => {
    const key = await capabilityKey("bootstrap-secret");
    await expect(signCapability(key, { ...claims, chat: "has space" })).rejects.toThrow();
    await expect(signCapability(key, { ...claims, expiresAt: claims.issuedAt })).rejects.toThrow();
    await expect(signCapability(key, { ...claims, kind: "admin" as never })).rejects.toThrow();
  });

  it("agrees between the container's synchronous signer and the edge's verifier", async () => {
    const secret = capabilitySecret("bootstrap-secret");
    const key = await capabilityKey("bootstrap-secret");
    const fromContainer = signCapabilitySync(secret, claims);
    expect(fromContainer).toBe(await signCapability(key, claims));
    expect(await verifyCapability(key, fromContainer, expect_)).toEqual({ ok: true, claims });
    expect(verifyCapabilitySync(secret, await signCapability(key, claims), expect_)).toEqual({ ok: true, claims });
    expect(verifyCapabilitySync(capabilitySecret("other"), fromContainer, expect_)).toEqual({ ok: false, reason: "forged" });
  });

  it("reads only signed bearer tokens from a header", () => {
    expect(bearerCapability(`Bearer ${SIGNED_CAPABILITY_PREFIX}a.b`)).toBe(`${SIGNED_CAPABILITY_PREFIX}a.b`);
    expect(bearerCapability("Bearer 0123abcd")).toBeNull();
    expect(bearerCapability(null)).toBeNull();
  });
});
