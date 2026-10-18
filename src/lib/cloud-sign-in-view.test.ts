import { describe, expect, it } from "vitest";
import { codeComplete, codeDigits, offerStatus, signInProblem, validEmail } from "./cloud-sign-in-view";

describe("sign-in view rules", () => {
  it("reads emails and codes the way the phone does", () => {
    expect(validEmail(" jo@example.test ")).toBe(true);
    for (const bad of ["", "jo", "jo@", "jo@x", "a b@c.d"]) expect(validEmail(bad)).toBe(false);
    expect(codeDigits("12 34-56 78 99")).toBe("12345678");
    expect(codeComplete("1234567")).toBe(false);
    expect(codeComplete("12345678")).toBe(true);
  });

  it("has a plain sentence for every way a sign-in can fail", () => {
    for (const code of ["invalid_email", "wrong_code", "expired_code", "rate_limited", "email_unavailable", "network", "unavailable"] as const) {
      for (const phase of ["send", "verify"] as const) expect(signInProblem(code, phase)).toMatch(/^cloudSignIn\.problem\./);
    }
  });

  it("holds the screen back until the Mac knows whether it was asked and who is signed in", () => {
    expect(offerStatus({ bridge: false, asked: true, card: "signed-out", failed: false })).toBe("done");
    expect(offerStatus({ bridge: true, asked: null, card: "signed-out", failed: false })).toBe("checking");
    expect(offerStatus({ bridge: true, asked: true, card: "loading", failed: false })).toBe("checking");
    expect(offerStatus({ bridge: true, asked: true, card: null, failed: false })).toBe("checking");
    expect(offerStatus({ bridge: true, asked: true, card: "signed-out", failed: false })).toBe("due");
    expect(offerStatus({ bridge: true, asked: false, card: "signed-out", failed: false })).toBe("done");
    expect(offerStatus({ bridge: true, asked: true, card: "signed-in", failed: false })).toBe("done");
    expect(offerStatus({ bridge: true, asked: true, card: "unreachable", failed: false })).toBe("done");
    expect(offerStatus({ bridge: true, asked: true, card: "signed-out", failed: true })).toBe("done");
  });

});
