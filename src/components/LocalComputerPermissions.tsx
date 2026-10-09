// What the Computer panel shows in place of This Mac's screen while a grant
// is missing: the two rows computer control needs, with the real system
// prompt behind each Allow. Nothing asks at launch (electron/cua.mjs reads
// the grants without prompting); the dog asks here, the first time it needs
// this Mac, and the driver starts by itself once both are given
// (electron/cua-grant.mjs). Pure, so ComputerPanel.simple.test.ts renders it
// as it is.
import { COMPUTER_PERMISSIONS, type ChecklistHost, type DesktopPermission, type DesktopPermissionChecklist } from "@/lib/desktop-permissions";
import { t } from "@/lib/i18n";
import { PermissionChecklist } from "./PermissionChecklist";

export function LocalComputerPermissions({
  dogName,
  host,
  checklist,
  busy,
  onRequest,
  onOpenSettings,
  onRelaunch,
}: {
  dogName: string;
  host: ChecklistHost;
  /** Null while the bridge has not answered. */
  checklist: DesktopPermissionChecklist | null;
  busy: DesktopPermission | null;
  onRequest: (permission: DesktopPermission) => void;
  onOpenSettings: (permission: DesktopPermission) => void;
  /** A Screen Recording grant applies after a relaunch. */
  onRelaunch?: () => void;
}) {
  return (
    <div className="mt-2 w-full max-w-[380px] rounded-xl bg-card px-4 text-left" data-testid="local-computer-permissions">
      <div className="pt-4 text-[14px] font-medium text-ink">{t("computer.local.allowTitle", { name: dogName })}</div>
      <p className="mt-1 pb-3 text-[12.5px] leading-relaxed text-ink-secondary">{t("computer.local.allowIntro", { name: dogName })}</p>
      <div className="border-t border-hairline/40">
        <PermissionChecklist
          host={host}
          checklist={checklist}
          busy={busy}
          onRequest={onRequest}
          onOpenSettings={onOpenSettings}
          onRelaunch={onRelaunch}
          permissions={COMPUTER_PERMISSIONS}
        />
      </div>
    </div>
  );
}
