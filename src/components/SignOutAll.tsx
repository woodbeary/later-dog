import { useEffect, useState, type RefObject } from "react";
import { LogOut } from "lucide-react";
import type { CloudAccountBridge, CloudAccountState, CloudPlanBridge } from "../../electron/cloud-account.mjs";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

export interface CloudSignOut {
  signOut(): Promise<CloudAccountState | void>;
}

export interface SignOutTargets {
  cloud: CloudSignOut | null;
}

export function cloudSignedIn(account: CloudAccountState | null): boolean {
  return account?.status === "connected" || account?.status === "reauth-required";
}

function desktopBridges(): { account?: CloudAccountBridge; plan?: CloudPlanBridge } {
  if (typeof window === "undefined" || window.laterdog?.remoteClient?.active) return {};
  const account = window.laterdog?.cloudAccount;
  return account ? { account } : { plan: window.laterdog?.cloudPlan };
}

function useCloudAccount(bridge: CloudAccountBridge | undefined): CloudAccountState | null {
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState((next) => { updated = true; if (active) setAccount(next); });
    void bridge.state().then((next) => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return account;
}

function useAnsweringPlan(plan: CloudPlanBridge | undefined): CloudPlanBridge | null {
  const [answering, setAnswering] = useState<CloudPlanBridge | null>(null);
  useEffect(() => {
    if (!plan) return;
    let active = true;
    void plan.state().then(() => { if (active) setAnswering(plan); }, () => {});
    return () => { active = false; };
  }, [plan]);
  return plan && answering === plan ? plan : null;
}

export function useSignOutTargets(): SignOutTargets {
  const { account: bridge, plan } = desktopBridges();
  const account = useCloudAccount(bridge);
  const answeringPlan = useAnsweringPlan(plan);
  if (bridge) return { cloud: cloudSignedIn(account) ? bridge : null };
  return { cloud: answeringPlan };
}

export async function signOutAll(targets: SignOutTargets): Promise<string[]> {
  if (!targets.cloud) return [];
  const reason = await targets.cloud.signOut().then(
    (next) => (!next || next.status === "signed-out" ? null : t("signOut.tryAgain")),
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  );
  return reason ? [t("signOut.failed", { name: t("settings.section.cloudAccount"), reason })] : [];
}

export function SignOutDialog({ targets, onClose, returnFocusRef }: {
  targets: SignOutTargets;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { dispatch } = useStore();
  const [pending, setPending] = useState(false);
  const confirm = async () => {
    setPending(true);
    const failed = await signOutAll(targets);
    setPending(false);
    onClose();
    if (failed.length) dispatch({ type: "error", message: failed.join(" ") });
  };
  return (
    <ConfirmDialog
      open
      title={t("signOut.title")}
      body={t("signOut.body", { accounts: t("settings.section.cloudAccount") })}
      confirmLabel={t("accounts.signOut")}
      icon={<LogOut size={18} />}
      pending={pending}
      returnFocusRef={returnFocusRef}
      onCancel={() => { if (!pending) onClose(); }}
      onConfirm={() => void confirm()}
    />
  );
}
