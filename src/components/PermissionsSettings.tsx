// Settings → Computers → Permissions: the welcome tour's checklist again, so
// a grant skipped on first run, or withdrawn later in System Settings, can
// be given from here. The Bot's computer panel's "This PC — Not ready" opens
// this page when a grant is what it is missing. Shown only on this
// computer's own page in the desktop app (SettingsModal filters on the bridge).
import { brand } from "@/lib/brand";
import { checklistHost } from "@/lib/desktop-permissions";
import { t } from "@/lib/i18n";
import { useDesktopPermissions } from "@/lib/use-desktop-permissions";
import { PermissionChecklist } from "./PermissionChecklist";
import { Card } from "./SettingsPrimitives";

export function PermissionsSettings() {
  const host = checklistHost(window.laterdog);
  const { checklist, busy, request, openSettings } = useDesktopPermissions({ active: host === "mac" });
  // Screen Recording applies after a relaunch; the desktop's own restart
  // path, offered only where the shell has it.
  const relaunch = host === "mac" && typeof window.laterdog?.relaunch === "function"
    ? () => void window.laterdog?.relaunch?.().catch(() => {})
    : undefined;
  return (
    <Card subtitle={t("permissions.card.subtitle", { app: brand().name })}>
      <PermissionChecklist
        host={host}
        checklist={checklist}
        busy={busy}
        onRequest={(permission) => void request(permission)}
        onOpenSettings={(permission) => void openSettings(permission)}
        onRelaunch={relaunch}
      />
    </Card>
  );
}
