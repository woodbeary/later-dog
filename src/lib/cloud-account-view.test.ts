import { describe, expect, it } from "vitest";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { cloudCard, homeStatusKey, PHONE_APP_URL } from "./cloud-account-view";

const account = { id: "user-1", email: "jo@example.test" };
const beta = { plan: "pro" as const, tier: "beta", status: "active" as const, expiresAt: 1_900_000_000_000, version: 1 };
const free = { plan: "free" as const, status: "inactive" as const, expiresAt: null, version: 1 };

describe("the later.dog Cloud card", () => {
  it("waits while a saved sign-in is still being read", () => {
    expect(cloudCard(null)).toEqual({ kind: "loading" });
    expect(cloudCard({ status: "signed-out", message: "restoring" })).toEqual({ kind: "loading" });
  });

  it("explains how the last sign-in ended", () => {
    expect(cloudCard({ status: "signed-out" })).toEqual({ kind: "signed-out", note: null });
    expect(cloudCard({ status: "signed-out", message: "enrollment-expired" })).toEqual({ kind: "signed-out", note: "cloudAccount.codeExpired" });
    expect(cloudCard({ status: "signed-out", message: "enrollment-ended" })).toEqual({ kind: "signed-out", note: "cloudAccount.signinFailed" });
    expect(cloudCard({ status: "signed-out", message: "restore-removed" })).toEqual({ kind: "signed-out", note: "cloudAccount.restoreRemoved" });
    expect(cloudCard({ status: "signed-out", message: "signout-local-only" })).toEqual({ kind: "signed-out", note: null });
  });

  it("shows the code the browser shows while signing in", () => {
    expect(cloudCard({ status: "connecting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: 5 } })).toEqual({ kind: "connecting", code: "ABCDE-FGHJK", until: 5 });
    expect(cloudCard({ status: "connecting" })).toEqual({ kind: "connecting", code: null, until: null });
  });

  it("names the beta, a paid plan, a full Cloud and a lapsed plan", () => {
    const signedIn = (patch: Partial<CloudAccountState>) => cloudCard({ status: "connected", account, ...patch });
    expect(signedIn({ entitlement: beta, machine: { status: "ready", origin: "https://h1-home.later.dog" } }))
      .toEqual({ kind: "signed-in", email: "jo@example.test", plan: "beta", home: { status: "ready", origin: "https://h1-home.later.dog" }, checking: false });
    expect(signedIn({ entitlement: { ...beta, tier: "pro" } })).toMatchObject({ plan: "paid", home: { status: "provisioning" } });
    expect(signedIn({ entitlement: beta })).toMatchObject({ plan: "beta", home: { status: "provisioning" } });
    expect(signedIn({ entitlement: free })).toMatchObject({ plan: "full", home: null });
    expect(signedIn({ entitlement: { ...beta, status: "inactive", expiresAt: null } })).toMatchObject({ plan: "inactive", home: null });
    expect(signedIn({ entitlement: free, machine: { status: "stopped" } })).toMatchObject({ plan: "inactive", home: { status: "stopped" } });
    expect(signedIn({ entitlement: beta, checking: true })).toMatchObject({ checking: true });
  });

  it("keeps the email when the sign-in needs renewing or Cloud can't be reached", () => {
    expect(cloudCard({ status: "reauth-required", account })).toEqual({ kind: "reauth", email: "jo@example.test" });
    expect(cloudCard({ status: "unavailable", account })).toEqual({ kind: "unreachable", email: "jo@example.test", note: "cloudAccount.unreachable" });
    expect(cloudCard({ status: "unavailable", message: "restore-failed" })).toEqual({ kind: "unreachable", email: null, note: "cloudAccount.restoreLocked" });
    expect(cloudCard({ status: "unavailable", message: "signout-storage-failed" })).toMatchObject({ note: "cloudAccount.storageFailed" });
  });

  it("says where My Cloud stands", () => {
    expect(homeStatusKey({ status: "provisioning" })).toBe("cloudAccount.home.provisioning");
    expect(homeStatusKey({ status: "provisioning", setup: { step: "starting", slow: true } })).toBe("cloudAccount.home.slow");
    expect(homeStatusKey({ status: "ready" })).toBe("cloudAccount.home.ready");
    expect(homeStatusKey({ status: "failed" })).toBe("cloudAccount.home.failed");
    expect(homeStatusKey({ status: "failed", retryAt: 9 })).toBe("cloudAccount.home.failedRetry");
    expect(homeStatusKey({ status: "payment-problem" })).toBe("cloudAccount.home.paymentProblem");
  });

  it("points the phone app link at the later.dog for iPhone page", () => {
    expect(PHONE_APP_URL).toBe("https://accounts.later.dog/iphone");
  });
});
