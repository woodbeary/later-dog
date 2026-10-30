import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";

export function autoReviewOn(config: ConfigStatus | null | undefined): boolean {
  return config?.features?.autoReview === true;
}

export function AutoReviewRow() {
  const { state, dispatch } = useStore();
  const on = autoReviewOn(state.config);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PATCH", body: JSON.stringify({ features: { autoReview: !on } }) });
      dispatch({ type: "configStatus", config });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.autoReview.title")}
      subtitle={t(on ? "settings.autoReview.on" : "settings.autoReview.off")}
      message={failed && <span role="alert" className="text-danger">{t("settings.autoReview.error")}</span>}
    >
      <Switch checked={on} disabled={saving} aria-label={t("settings.autoReview.title")} data-auto-review={on ? "on" : "off"} onClick={() => void toggle()} />
    </SettingRow>
  );
}
