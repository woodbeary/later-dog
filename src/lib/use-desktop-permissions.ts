import { useCallback, useEffect, useState } from "react";
import { permissionBridge, readChecklist, type DesktopPermission, type DesktopPermissionChecklist } from "./desktop-permissions";

export interface DesktopPermissionsState {
  checklist: DesktopPermissionChecklist | null;
  busy: DesktopPermission | null;
  refresh: () => Promise<void>;
  request: (permission: DesktopPermission) => Promise<void>;
  openSettings: (permission: DesktopPermission) => Promise<void>;
}

export function useDesktopPermissions({ active = true, intervalMs = 2000 }: { active?: boolean; intervalMs?: number } = {}): DesktopPermissionsState {
  const bridge = permissionBridge(typeof window === "undefined" ? undefined : window.laterdog);
  const [checklist, setChecklist] = useState<DesktopPermissionChecklist | null>(null);
  const [busy, setBusy] = useState<DesktopPermission | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setChecklist(readChecklist(await bridge.status()));
    } catch {}
  }, [bridge]);

  useEffect(() => {
    if (!bridge || !active) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [bridge, active, intervalMs, refresh]);

  const request = useCallback(async (permission: DesktopPermission) => {
    if (!bridge) return;
    setBusy(permission);
    try {
      setChecklist(readChecklist(await bridge.request(permission)));
    } catch {
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [bridge, refresh]);

  const openSettings = useCallback(async (permission: DesktopPermission) => {
    try {
      await bridge?.openSettings(permission);
    } catch {}
  }, [bridge]);

  return { checklist, busy, refresh, request, openSettings };
}
