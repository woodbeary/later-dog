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
  checklist: DesktopPermissionChecklist | null;
  busy: DesktopPermission | null;
  onRequest: (permission: DesktopPermission) => void;
  onOpenSettings: (permission: DesktopPermission) => void;
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
