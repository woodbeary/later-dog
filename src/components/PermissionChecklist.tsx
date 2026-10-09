// The permissions checklist, one row per macOS grant, drawn wherever later.dog lists them (Settings → Computers →
// Permissions; the Computer panel, the first time a dog needs this Mac) from one hook, so a grant reads the same
// everywhere. Each row: plain words for what it lets a dog do, and one thing on the right — the action that moves it
// forward (Allow, the real system prompt; or Open System Settings), or the status once there is nothing to do
// (src/lib/desktop-permissions.ts rowActions says which). Rows sit on the surface they are placed on, separated by
// hairlines, never as cards of their own.
import type { CSSProperties } from "react";
import { Accessibility, Check, Loader2, Mic, MonitorDot } from "lucide-react";
import { brand } from "@/lib/brand";
import { cn } from "@/lib/cn";
import {
  DESKTOP_PERMISSIONS,
  permissionName,
  rowActions,
  statusLabel,
  type ChecklistHost,
  type DesktopPermission,
  type DesktopPermissionChecklist,
  type DesktopPermissionStatus,
} from "@/lib/desktop-permissions";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const ICONS: Record<DesktopPermission, typeof Mic> = { microphone: Mic, accessibility: Accessibility, screen: MonitorDot };

const DETAIL: Record<DesktopPermission, LocaleKey> = {
  microphone: "onboarding.perms.micDetail",
  accessibility: "permissions.accessibilityDetail",
  screen: "permissions.screenDetail",
};

const actionClass = "rounded-lg bg-raised px-3 py-1.5 text-[12.5px] text-ink transition-colors hover:bg-raised-hover disabled:opacity-50";

function StatusPill({ status, host }: { status: DesktopPermissionStatus | null; host: ChecklistHost }) {
  const tone = host !== "mac" || status === null || status === "unavailable"
    ? "bg-raised text-ink-secondary"
    : status === "granted"
      ? "bg-success/15 text-success"
      : status === "denied"
        ? "bg-warning/15 text-warning"
        : "bg-raised text-ink-secondary";
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", tone)} data-testid="permission-status">
      {host === "mac" && status === "granted" && <Check size={12} aria-hidden="true" />}
      {statusLabel(status, host)}
    </span>
  );
}

export function PermissionChecklist({
  host,
  checklist,
  busy,
  onRequest,
  onOpenSettings,
  onRelaunch,
  permissions = DESKTOP_PERMISSIONS,
  stagger = false,
}: {
  host: ChecklistHost;
  /** Null while the bridge has not answered. */
  checklist: DesktopPermissionChecklist | null;
  busy: DesktopPermission | null;
  onRequest: (permission: DesktopPermission) => void;
  onOpenSettings: (permission: DesktopPermission) => void;
  /** Settings only: a Screen Recording grant applies after a relaunch. */
  onRelaunch?: () => void;
  /** The rows to draw, in order; the Computer panel asks only for the two computer control needs. */
  permissions?: readonly DesktopPermission[];
  /** The welcome tour's rows arrive one after another. */
  stagger?: boolean;
}) {
  const app = brand().name;
  return (
    <div className={cn("flex flex-col divide-y divide-hairline/40", stagger && "stagger")} data-testid="permission-checklist">
      {host !== "mac" && (
        <p className={cn("pb-3 text-[12.5px] text-ink-secondary", stagger && "animate-rise")} style={stagger ? ({ "--i": 1 } as CSSProperties) : undefined}>
          {host === "browser" ? t("permissions.browserNote", { app }) : t("permissions.otherDesktopNote")}
        </p>
      )}
      {permissions.map((permission, index) => {
        const status: DesktopPermissionStatus | null = host === "mac" ? (checklist?.[permission] ?? null) : "unavailable";
        const actions = rowActions(permission, status, host);
        const relaunch = actions.relaunchNote && onRelaunch;
        const Icon = ICONS[permission];
        // One thing on the right: the action when there is one (it already says the switch is off), else the status.
        const action = actions.enable
          ? (
            <button type="button" disabled={busy !== null} onClick={() => onRequest(permission)} className={cn(actionClass, "inline-flex items-center gap-1.5")}>
              {busy === permission && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              {t("permissions.allow")}
            </button>
          )
          : actions.settings
            ? <button type="button" onClick={() => onOpenSettings(permission)} className={actionClass}>{t("permissions.openSystemSettings")}</button>
            : <StatusPill status={status} host={host} />;
        return (
          <div
            key={permission}
            className={cn("flex items-center justify-between gap-4 py-3", stagger && "animate-rise")}
            style={stagger ? ({ "--i": index + 2 } as CSSProperties) : undefined}
            data-permission={permission}
            data-status={status ?? "checking"}
          >
            <div className="flex min-w-0 items-start gap-3">
              <Icon size={18} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink">{permissionName(permission)}</div>
                <div className="mt-0.5 text-[12.5px] text-ink-secondary">{t(DETAIL[permission])}</div>
                {/* one note: the stale-build hint when it applies (it ends where the relaunch note would), else the relaunch note */}
                {(actions.staleHint || actions.relaunchNote) && (
                  <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
                    {actions.staleHint ? t("permissions.staleHint", { app }) : t("permissions.screenRelaunch", { app })}
                    {relaunch && (
                      <button type="button" onClick={onRelaunch} className="ml-1.5 text-ink-secondary underline underline-offset-2 transition-colors hover:text-ink">
                        {t("computer.mac.permission.relaunch")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center">{action}</div>
          </div>
        );
      })}
    </div>
  );
}
