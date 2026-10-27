import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { voiceNoteButtonShown } from "@/lib/feature-flags";
import { SettingRow, Switch } from "./SettingsPrimitives";

export function VoiceNoteButtonRow() {
  const { state, dispatch } = useStore();
  const on = voiceNoteButtonShown(state.config);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PATCH", body: JSON.stringify({ features: { voiceNoteButton: !on } }) });
      dispatch({ type: "configStatus", config });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.voiceNoteButton.title")}
      subtitle={t(on ? "settings.voiceNoteButton.on" : "settings.voiceNoteButton.off")}
      message={failed && <span role="alert" className="text-danger">{t("settings.autoReview.error")}</span>}
    >
      <Switch checked={on} disabled={saving} aria-label={t("settings.voiceNoteButton.title")} data-voice-note-button={on ? "on" : "off"} onClick={() => void toggle()} />
    </SettingRow>
  );
}
