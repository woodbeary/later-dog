import { useEffect, useState, type RefObject } from "react";
import { LogOut } from "lucide-react";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

export interface SignOutTargets {
  cloud: CloudAccountBridge | null;
}

export function cloudSignedIn(account: CloudAccountState | null): boolean {
  return account?.status === "connected" || account?.status === "reauth-required";
}

function useCloudAccount(): { bridge: CloudAccountBridge | undefined; account: CloudAccountState | null } {
  const bridge = typeof window === "undefined" ? undefined : window.laterdog?.cloudAccount;
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
  const { bridge, account } = useCloudAccount();
  return { cloud: bridge && cloudSignedIn(account) ? bridge : null };
}

export async function signOutAll(targets: SignOutTargets): Promise<string[]> {
  if (!targets.cloud) return [];
  const reason = await targets.cloud.signOut().then(
    (next) => (next.status === "signed-out" ? null : t("signOut.tryAgain")),
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
    if (failed.length) dispatch({ type: "reportError", error: null, pane: "sidebar", line: failed.join(" ") });
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
