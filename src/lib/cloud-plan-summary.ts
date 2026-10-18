import { useEffect, useState } from "react";
import type { CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudLendingBridge } from "../../electron/computer-sharing.mjs";
import type { CloudCard, CloudPlanLine } from "./cloud-account-view";

export interface CloudPlanSummary {
  email: string | null;
  line: CloudPlanLine | null;
  checking: boolean;
  signIn: boolean;
}

export function summaryFromCard(card: CloudCard): CloudPlanSummary | null {
  if (card.kind === "signed-in") return { email: card.email || null, line: card.plan, checking: card.checking, signIn: false };
  if (card.kind === "reauth") return { email: card.email, line: null, checking: false, signIn: true };
  if (card.kind === "unreachable") return { email: card.email, line: null, checking: true, signIn: false };
  return null;
}

export function summaryFromSnapshot(snapshot: CloudPlanSnapshot | null): CloudPlanSummary | null {
  if (!snapshot) return null;
  const email = typeof snapshot.email === "string" && snapshot.email ? snapshot.email : null;
  switch (snapshot.status) {
    case "paid": return { email, line: snapshot.tier === "beta" ? "beta" : "paid", checking: false, signIn: false };
    case "attention": return { email, line: "inactive", checking: false, signIn: false };
    case "checking": return { email, line: snapshot.tier === "beta" ? "beta" : "paid", checking: true, signIn: false };
    case "signin": return { email, line: null, checking: false, signIn: true };
    case "none": return { email, line: "inactive", checking: false, signIn: false };
  }
}

export function cloudPlanBridge(): CloudPlanBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.laterdog?.cloudPlan;
}

function usableLending(bridge: Partial<CloudLendingBridge> | undefined): CloudLendingBridge | undefined {
  return bridge && typeof bridge.state === "function" && typeof bridge.setHome === "function" ? bridge as CloudLendingBridge : undefined;
}

export function cloudLendingBridge(): CloudLendingBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const laterdog = window.laterdog as { cloudAccount?: { lending?: Partial<CloudLendingBridge> }; cloudLending?: Partial<CloudLendingBridge> } | undefined;
  return usableLending(laterdog?.cloudAccount?.lending) ?? usableLending(laterdog?.cloudLending);
}

export function useCloudPagePlan(bridge: CloudPlanBridge): { summary: CloudPlanSummary | null; failed: boolean } {
  const [summary, setSummary] = useState<CloudPlanSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const read = () => void bridge.state()
      .then((snapshot) => { if (active) { setSummary(summaryFromSnapshot(snapshot)); setFailed(false); } })
      .catch(() => { if (active) setFailed(true); });
    read();
    window.addEventListener("focus", read);
    return () => { active = false; window.removeEventListener("focus", read); };
  }, [bridge]);
  return { summary, failed };
}
