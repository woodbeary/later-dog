import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { readHomeTimeZone, zoneLabel } from "@/lib/time-zone-sync";
import { SettingRow } from "./SettingsPrimitives";

export function TimeZoneRow() {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void readHomeTimeZone().then((home) => { if (alive && home) setZone(home.saved ?? home.timeZone); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!zone) return null;
  return (
    <SettingRow title={t("settings.timeZone.title")} subtitle={t("settings.timeZone.hint")}>
      <span data-time-zone={zone} className="block text-[13px] text-ink-secondary sm:text-right">{zoneLabel(zone)}</span>
    </SettingRow>
  );
}
