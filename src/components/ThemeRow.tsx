import { useState } from "react";
import { t } from "@/lib/i18n";
import { SKINS } from "@/lib/skins";
import { applyTheme, readTheme, themeOptions, type Theme } from "@/lib/theme";
import { SettingRow } from "./SettingsPrimitives";

function label(theme: Theme): string {
  if (theme === "system") return t("settings.theme.system");
  if (theme === "daylight") return t("settings.theme.light");
  if (theme === "midnight") return t("settings.theme.dark");
  return SKINS.find((skin) => skin.id === theme)?.name ?? theme;
}

export function ThemeRow() {
  const [theme, setTheme] = useState(readTheme);
  const options = themeOptions(theme);
  return (
    <SettingRow title={t("settings.skin.title")}>
      <select value={theme} aria-label={t("settings.skin.title")} onChange={(event) => {
        const next = options.find((option) => option === event.target.value);
        if (!next) return;
        applyTheme(next);
        setTheme(next);
      }}
        className="min-h-8 w-full max-w-[240px] rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink focus:border-focus disabled:cursor-wait disabled:opacity-50">
        {options.map((option) => (<option key={option} value={option}>{label(option)}</option>))}
      </select>
    </SettingRow>
  );
}
