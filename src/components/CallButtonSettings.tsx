import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { callButtonShown } from "@/lib/feature-flags";
import { SettingRow, Switch } from "./SettingsPrimitives";

export function CallButtonRow() {
  const { state, dispatch } = useStore();
  const on = callButtonShown(state.config);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PATCH", body: JSON.stringify({ features: { callButton: !on } }) });
      dispatch({ type: "configStatus", config });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.callButton.title")}
      subtitle={t(on ? "settings.callButton.on" : "settings.callButton.off")}
      message={failed && <span role="alert" className="text-danger">{t("settings.autoReview.error")}</span>}
    >
      <Switch checked={on} disabled={saving} aria-label={t("settings.callButton.title")} data-call-button={on ? "on" : "off"} onClick={() => void toggle()} />
    </SettingRow>
  );
}
