import { useState } from "react";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { FEEDBACK_URL, HELP_CENTER_URL, appVersion, openExternalLink, platformLabel } from "@/lib/app-links";
import { AboutDialog } from "./AboutDialog";
import { SettingRow } from "./SettingsPrimitives";
import { shortcutLabel } from "./ShortcutHint";

const pill = "rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover";

export function HelpRows() {
  const { dispatch } = useStore();
  const [aboutOpen, setAboutOpen] = useState(false);
  const platform = platformLabel(typeof window === "undefined" ? undefined : window.laterdog?.platform);
  const showShortcuts = () => {
    dispatch({ type: "toggleAppSettings", open: false });
    dispatch({ type: "toggleShortcuts", open: true });
  };
  return (
    <>
      <SettingRow title={t("settings.help.shortcuts")} subtitle={shortcutLabel("shortcuts-cheat-sheet")}>
        <button type="button" data-settings-help="shortcuts" onClick={showShortcuts} className={pill}>{t("settings.help.show")}</button>
      </SettingRow>
      <SettingRow title={t("sidebar.menu.help")}>
        <button type="button" data-settings-help="help" onClick={() => void openExternalLink(HELP_CENTER_URL)} className={pill}>{t("settings.help.open")}</button>
      </SettingRow>
      <SettingRow title={t("sidebar.menu.feedback")}>
        <button type="button" data-settings-help="feedback" onClick={() => void openExternalLink(FEEDBACK_URL)} className={pill}>{t("settings.help.open")}</button>
      </SettingRow>
      <SettingRow title={t("sidebar.menu.about")} subtitle={[appVersion(), platform].filter(Boolean).join(" · ")}>
        <button type="button" data-settings-help="about" onClick={() => setAboutOpen(true)} className={pill}>{t("settings.help.open")}</button>
      </SettingRow>
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  );
}
