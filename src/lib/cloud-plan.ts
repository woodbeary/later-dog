import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";

const PLAN_LABEL: Record<string, string> = { personal: "Personal", pro: "Pro", max: "Max" };
export function cloudPlanLabel(tier?: string): string {
  return tier === undefined ? "Pro" : Object.hasOwn(PLAN_LABEL, tier) ? PLAN_LABEL[tier] : "Cloud";
}

export type CloudPlanView =
  | { kind: "unknown" }
  | { kind: "signed-out" }
  | { kind: "connecting" }
  | { kind: "free" }
  | { kind: "paid"; label: string; checking: boolean }
  | { kind: "attention"; label: string | null }
  | { kind: "purchase"; label: string | null; paidAt?: number }
  | { kind: "unverified"; label: string | null }
  | { kind: "reauth"; label: string | null; reason: "expired" | "access-ended" };

export function cloudPlanView(account: CloudAccountState | null | undefined): CloudPlanView {
  if (!account || (account.status === "signed-out" && account.message === "restoring")) return { kind: "unknown" };
  const last = account.lastPlan ? cloudPlanLabel(account.lastPlan.tier) : null;
  if (account.status === "signed-out") return { kind: "signed-out" };
  if (account.status === "connecting") return { kind: "connecting" };
  if (account.status === "reauth-required") return { kind: "reauth", label: last, reason: account.message === "expired" ? "expired" : "access-ended" };
  if (account.status !== "connected") return { kind: "unverified", label: last };
  const entitlement = account.entitlement;
  if (entitlement?.plan === "pro" && entitlement.status === "active") return { kind: "paid", label: cloudPlanLabel(entitlement.tier), checking: account.checking === true };
  if (account.purchase) {
    return { kind: "purchase", label: account.purchase.tier ? cloudPlanLabel(account.purchase.tier) : null, ...(account.purchase.paidAt ? { paidAt: account.purchase.paidAt } : {}) };
  }
  if (entitlement?.plan === "pro") return { kind: "attention", label: cloudPlanLabel(entitlement.tier) };
  if (account.machine) return { kind: "attention", label: null };
  return { kind: "free" };
}

export function buyOfferAllowed(view: CloudPlanView): boolean {
  return view.kind === "signed-out" || view.kind === "free";
}

export function cloudPlanLine(view: CloudPlanView): string | null {
  switch (view.kind) {
    case "paid": return t("cloudAccount.pro", { plan: view.label });
    case "attention": return t("cloudAccount.inactive", { plan: view.label ?? "later.dog Cloud" });
    case "purchase": return t("cloudAccount.purchaseReceived", { plan: view.label ?? "later.dog Cloud" });
    case "unverified": return view.label ? t("cloudAccount.lastPlan", { plan: view.label }) : null;
    case "reauth": return view.label ? t("cloudAccount.planName", { plan: view.label }) : null;
    case "free": return t("cloudAccount.free");
    default: return null;
  }
}

export async function startCloudPlan(): Promise<void> {
  const next = await api<{ state: string; url?: string }>("/api/computers/plan", { method: "POST" });
  if (next.state !== "checkout" || !next.url) throw new Error("later.dog Cloud isn't available to buy here.");
  await openExternalLink(next.url);
}
