// The dog editor's three tabs. Files outside the editor still deep-link
// with the older, finer BotSettingsSection ids (toggleSettings { section });
// tabForSection folds those onto a tab, and each tab writes back the one
// section id it stands for so the store stays the single source of truth.
import type { BotSettingsSection } from "@/state/store";
import type { LocaleKey } from "@/locales";

export type BotSettingsTab = "details" | "library" | "computer";

export const BOT_SECTIONS: ReadonlyArray<{
  id: BotSettingsTab;
  /** The section id the tab dispatches when chosen. */
  section: BotSettingsSection;
  labelKey: LocaleKey;
}> = [
  { id: "details", section: "identity", labelKey: "botSettings.simple.details" },
  { id: "library", section: "skills", labelKey: "botSettings.simple.library" },
  { id: "computer", section: "access", labelKey: "botSettings.simple.computer" },
];

export function tabForSection(section: BotSettingsSection): BotSettingsTab {
  switch (section) {
    case "skills":
    case "memory":
      return "library";
    case "access":
      return "computer";
    default:
      return "details";
  }
}
