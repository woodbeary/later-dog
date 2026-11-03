import type { WireWaitingOn } from "../../shared/wire";
import { activeLocale, t } from "@/lib/i18n";

export function teammateNames(waitingOn: readonly WireWaitingOn[] | undefined, locale: string = activeLocale()): string | null {
  const names = [...new Set((waitingOn ?? []).map((teammate) => teammate.name.trim()).filter(Boolean))];
  return names.length ? new Intl.ListFormat(locale, { type: "conjunction" }).format(names) : null;
}

export function waitingOnStatus(waitingOn: readonly WireWaitingOn[] | undefined): string {
  const names = teammateNames(waitingOn);
  return names ? t("chat.waitingOn", { names }) : t("chat.teammatesWorking");
}

export function waitingOnPreview(waitingOn: readonly WireWaitingOn[] | undefined): string {
  const names = teammateNames(waitingOn);
  return names ? t("sidebar.preview.waitingOn", { names }) : t("sidebar.preview.waitingOnTeammate");
}
