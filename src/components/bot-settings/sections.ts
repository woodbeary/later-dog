import type { BotSettingsSection } from "@/state/store";
import type { LocaleKey } from "@/locales";

export type BotSettingsTab = "details" | "library";

export const BOT_SECTIONS: ReadonlyArray<{
  id: BotSettingsTab;
  section: BotSettingsSection;
  labelKey: LocaleKey;
}> = [
  { id: "details", section: "identity", labelKey: "botSettings.simple.details" },
  { id: "library", section: "skills", labelKey: "botSettings.simple.library" },
];

export function tabForSection(section: BotSettingsSection): BotSettingsTab {
  switch (section) {
    case "skills":
    case "memory":
      return "library";
    default:
      return "details";
  }
}
