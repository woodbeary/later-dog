import { useEffect, useState } from "react";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudMachine } from "../../electron/cloud-home.mjs";
import type { LocaleKey } from "@/locales";

export const PHONE_APP_URL = "https://accounts.later.dog/iphone";

export type CloudPlanLine = "beta" | "paid" | "full" | "inactive";

export type CloudCard =
  | { kind: "loading" }
  | { kind: "signed-out"; note: LocaleKey | null }
  | { kind: "connecting"; code: string | null; until: number | null }
  | { kind: "signed-in"; email: string; plan: CloudPlanLine; home: CloudMachine | null; checking: boolean }
  | { kind: "reauth"; email: string | null }
  | { kind: "unreachable"; email: string | null; note: LocaleKey };

const SIGNED_OUT_NOTES: Partial<Record<string, LocaleKey>> = {
  "enrollment-expired": "cloudAccount.codeExpired",
  "enrollment-ended": "cloudAccount.signinFailed",
  "signin-failed": "cloudAccount.signinFailed",
  "restore-removed": "cloudAccount.restoreRemoved",
};

const UNREACHABLE_NOTES: Partial<Record<string, LocaleKey>> = {
  "restore-failed": "cloudAccount.restoreLocked",
  "signout-storage-failed": "cloudAccount.storageFailed",
};

function planLine(account: CloudAccountState): CloudPlanLine {
  const entitlement = account.entitlement;
  if (entitlement?.plan === "pro" && entitlement.status === "active") return entitlement.tier === "beta" ? "beta" : "paid";
  if (entitlement?.plan === "pro" || account.machine) return "inactive";
  return "full";
}

export function cloudCard(account: CloudAccountState | null): CloudCard {
  if (!account || (account.status === "signed-out" && account.message === "restoring")) return { kind: "loading" };
  const email = account.account?.email ?? null;
  switch (account.status) {
    case "signed-out":
      return { kind: "signed-out", note: SIGNED_OUT_NOTES[account.message ?? ""] ?? null };
    case "connecting":
      return { kind: "connecting", code: account.enrollment?.userCode ?? null, until: account.enrollment?.expiresAt ?? null };
    case "reauth-required":
      return { kind: "reauth", email };
    case "unavailable":
      return { kind: "unreachable", email, note: UNREACHABLE_NOTES[account.message ?? ""] ?? "cloudAccount.unreachable" };
    case "connected": {
      const plan = planLine(account);
      const home = account.machine ?? (plan === "beta" || plan === "paid" ? { status: "provisioning" as const } : null);
      return { kind: "signed-in", email: email ?? "", plan, home, checking: account.checking === true };
    }
  }
}

export const HOME_STATUS: Record<CloudMachine["status"], LocaleKey> = {
  provisioning: "cloudAccount.home.provisioning",
  ready: "cloudAccount.home.ready",
  stopped: "cloudAccount.home.stopped",
  "payment-problem": "cloudAccount.home.paymentProblem",
  failed: "cloudAccount.home.failed",
};

export function homeStatusKey(home: CloudMachine): LocaleKey {
  if (home.status === "provisioning" && home.setup?.slow) return "cloudAccount.home.slow";
  if (home.status === "failed" && home.retryAt) return "cloudAccount.home.failedRetry";
  return HOME_STATUS[home.status];
}

export function cloudAccountBridge(): CloudAccountBridge | undefined {
  if (typeof window === "undefined" || window.laterdog?.remoteClient?.active) return undefined;
  return window.laterdog?.cloudAccount;
}

export function useCloudAccount(bridge: CloudAccountBridge | undefined = cloudAccountBridge()): {
  account: CloudAccountState | null;
  failed: boolean;
  accept: (next: CloudAccountState) => void;
} {
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState((next) => {
      updated = true;
      if (active) { setAccount(next); setFailed(false); }
    });
    void bridge.state().then((next) => { if (active && !updated) setAccount(next); }).catch(() => { if (active && !updated) setFailed(true); });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return { account, failed, accept: (next) => { setAccount(next); setFailed(false); } };
}
