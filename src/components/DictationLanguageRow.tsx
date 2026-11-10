import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { SettingRow } from "./SettingsPrimitives";

export function DictationLanguageRow() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = async (dictationLanguage: "en" | "auto") => {
    setSaving(true);
    setFailed(false);
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PATCH", body: JSON.stringify({ dictationLanguage }) });
      dispatch({ type: "configStatus", config });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingRow title={t("settings.dictationLanguage.title")} subtitle={t("settings.dictationLanguage.hint")} message={failed && <span role="alert" className="text-danger">{t("settings.autoReview.error")}</span>}>
      <select aria-label={t("settings.dictationLanguage.title")} value={state.config?.dictationLanguage ?? "en"} disabled={saving} onChange={(event) => void save(event.target.value === "auto" ? "auto" : "en")} className="rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink">
        <option value="en">{t("settings.dictationLanguage.english")}</option>
        <option value="auto">{t("settings.dictationLanguage.auto")}</option>
      </select>
    </SettingRow>
  );
}
