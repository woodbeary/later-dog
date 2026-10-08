// The live permissions checklist, for every surface that draws it. Polls
// while `active` (the person grants in System Settings and comes back) and
// on every window focus; a request replaces the checklist with the bridge's
// answer to it. Without the bridge the checklist stays null and nothing
// is asked, so a browser renders the same rows with their desktop-only words.
import { useCallback, useEffect, useState } from "react";
import { permissionBridge, readChecklist, type DesktopPermission, type DesktopPermissionChecklist } from "./desktop-permissions";

export interface DesktopPermissionsState {
  /** Null until the bridge answers, and always without a bridge. */
  checklist: DesktopPermissionChecklist | null;
  /** The grant whose system prompt is open right now. */
  busy: DesktopPermission | null;
  refresh: () => Promise<void>;
  /** Shows the real system prompt for one grant, then re-reads them all. */
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
    } catch {
      // an older shell without the channel: the rows keep saying "Checking…"
    }
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
    } catch {
      // System Settings could not be opened; the row still says what is missing
    }
  }, [bridge]);

  return { checklist, busy, refresh, request, openSettings };
}
