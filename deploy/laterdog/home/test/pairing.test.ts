import { describe, expect, it } from "vitest";
import { parsePairingGrant } from "../src/pairing.ts";

describe("pairing grants from a home", () => {
  it("accepts only well-formed, short-lived grants", () => {
    const now = Date.now();
    expect(parsePairingGrant({ code: "ABCD-EFGH-JKLM", credential: "laterdog_pair_0123456789abcdefghij", expiresAt: now + 60_000 }, now)).not.toBeNull();
    expect(parsePairingGrant({ code: "ABCD-EFGH-JKLM", credential: "laterdog_pair_0123456789abcdefghij", expiresAt: now + 60 * 60_000 }, now)).toBeNull();
    expect(parsePairingGrant({ code: "abcd", credential: "x", expiresAt: now + 1000 }, now)).toBeNull();
  });
});
