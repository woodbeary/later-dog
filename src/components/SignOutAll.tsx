import { useEffect, useState, type RefObject } from "react";
import { LogOut } from "lucide-react";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import { api, useStore, type Action, type ConfigStatus, type InstanceInfo } from "@/state/store";
import { activeLocale, t } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { signedIn, subscriptionAccounts } from "./AccountsPanel";

export interface SignOutTargets {
  accounts: InstanceInfo[];
  cloud: CloudAccountBridge | null;
  names: string[];
}

export function signOutAccounts(instances: readonly InstanceInfo[], battery: ConfigStatus["accountBattery"]): InstanceInfo[] {
  return subscriptionAccounts(instances, battery).filter((instance) => signedIn(instance) && instance.authentication?.signOut === true);
}

export function cloudSignedIn(account: CloudAccountState | null): boolean {
  return account?.status === "connected" || account?.status === "reauth-required";
}

export function nameList(names: readonly string[]): string {
  try {
    return new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

function useCloudAccount(): { bridge: CloudAccountBridge | undefined; account: CloudAccountState | null } {
  const bridge = typeof window === "undefined" || window.laterdog?.remoteClient?.active ? undefined : window.laterdog?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState((next) => { updated = true; if (active) setAccount(next); });
    void bridge.state().then((next) => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return { bridge, account };
}

export function useSignOutTargets(): SignOutTargets {
  const { state } = useStore();
  const { bridge, account } = useCloudAccount();
  const accounts = signOutAccounts(state.instances, state.config?.accountBattery);
  const cloud = bridge && cloudSignedIn(account) ? bridge : null;
  return { accounts, cloud, names: [...accounts.map((instance) => instance.displayName), ...(cloud ? [t("settings.section.cloudAccount")] : [])] };
}

export async function signOutAll(targets: SignOutTargets, dispatch: (action: Action) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const account of targets.accounts) {
    try {
      const { instances } = await api<{ instances: InstanceInfo[] }>(`/api/instances/${encodeURIComponent(account.instanceId)}/auth/sign-out`, { method: "POST" });
      dispatch({ type: "instances", instances });
    } catch (cause) {
      failed.push(t("signOut.failed", { name: account.displayName, reason: cause instanceof Error ? cause.message : String(cause) }));
    }
  }
  if (targets.cloud) {
    const reason = await targets.cloud.signOut().then(
      (next) => (next.status === "signed-out" ? null : t("signOut.tryAgain")),
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );
    if (reason) failed.push(t("signOut.failed", { name: t("settings.section.cloudAccount"), reason }));
  }
  return failed;
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
    const failed = await signOutAll(targets, dispatch);
    setPending(false);
    onClose();
    if (failed.length) dispatch({ type: "error", message: failed.join(" ") });
  };
  return (
    <ConfirmDialog
      open
      title={t("signOut.title")}
      body={t("signOut.body", { accounts: nameList(targets.names) })}
      confirmLabel={t("accounts.signOut")}
      icon={<LogOut size={18} />}
      pending={pending}
      returnFocusRef={returnFocusRef}
      onCancel={() => { if (!pending) onClose(); }}
      onConfirm={() => void confirm()}
    />
  );
}
