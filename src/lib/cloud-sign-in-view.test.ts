import { describe, expect, it } from "vitest";
import { cloudCard } from "@/lib/cloud-account-view";
import { codeComplete, codeDigits, gateLine, offerStatus, signInProblem, validEmail } from "./cloud-sign-in-view";

const account = { id: "a", email: "a@b.test" };
const beta = { plan: "pro" as const, tier: "beta", status: "active" as const, expiresAt: 1_900_000_000_000, version: 1 };

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

  it("knows what to say once signed in: open the home, wait for it, or let the person carry on here", () => {
    const line = (machine: unknown, entitlement: unknown = beta) => gateLine(cloudCard({ status: "connected", account, entitlement, ...(machine ? { machine } : {}) } as never));
    expect(line({ status: "ready", origin: "https://h.later.dog" })).toEqual({ kind: "opening" });
    expect(line({ status: "provisioning", setup: { step: "storage" } })).toEqual({ kind: "setting-up", slow: false });
    expect(line({ status: "provisioning", setup: { step: "storage", slow: true } })).toEqual({ kind: "setting-up", slow: true });
    expect(line({ status: "failed" })).toEqual({ kind: "stuck", note: "cloudAccount.home.failed" });
    expect(line({ status: "stopped" })).toEqual({ kind: "stuck", note: "cloudAccount.home.stopped" });
    expect(line({ status: "payment-problem" })).toEqual({ kind: "stuck", note: "cloudAccount.home.paymentProblem" });
    expect(line(null, { plan: "free", status: "inactive", expiresAt: null, version: 1 })).toEqual({ kind: "stuck", note: "cloudAccount.plan.full" });
    expect(gateLine(cloudCard({ status: "signed-out" }))).toBeNull();
  });
});
