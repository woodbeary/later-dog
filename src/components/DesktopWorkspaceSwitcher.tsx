import { useState } from "react";
import { SettingRow } from "./SettingsPrimitives";

export function DesktopWorkspaceSwitcher() {
  const bridge = window.laterdog?.workspaces;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!bridge) return null;
  const openMenu = async () => {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await bridge.menu();
    } catch {
      setError("Could not open saved workspaces. Try the Server menu.");
    } finally {
      setBusy(false);
    }
  };
  return <details data-workspace-recovery className="rounded-xl bg-card px-4">
    <summary className="cursor-pointer py-4 text-[13px] font-medium text-ink-secondary">Advanced</summary>
    <SettingRow title="Workspace recovery" subtitle="Reconnect to a saved workspace if your chats are missing."
      message={error ? <p role="alert" className="text-danger">{error}</p> : undefined}>
      <button type="button" onClick={() => void openMenu()} disabled={busy} aria-haspopup="menu"
        className="rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover disabled:opacity-45">
        Open saved workspaces
      </button>
    </SettingRow>
  </details>;
}
