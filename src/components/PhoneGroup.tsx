import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

export interface PhoneStatus {
  id: string;
  name: string;
  online: boolean;
  can: string[];
  lastSeenAt: number;
}

export function phoneLine(phone: PhoneStatus): string {
  if (!phone.online) return t("settings.phone.offline");
  return t(phone.can.length > 0 ? "settings.phone.ready" : "settings.phone.update");
}

export function PhoneGroup() {
  const [phones, setPhones] = useState<PhoneStatus[]>([]);

  useEffect(() => {
    let alive = true;
    void api<{ phones?: PhoneStatus[] }>("/api/phone/device", { timeoutMs: 5_000 }).then((answer) => { if (alive) setPhones(answer.phones ?? []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (phones.length === 0) return null;
  return (
    <SettingsGroup label={t(phones.length === 1 ? "settings.group.phone" : "settings.group.phones")} testId="your-iphone">
      <SettingsRows>
        {phones.map((phone) => (
          <SettingRow key={phone.id} title={phone.name} subtitle={phoneLine(phone)}>
            <span
              data-phone-online={phone.online ? "true" : "false"}
              className={cn("inline-flex shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium", phone.online ? "bg-success/10 text-success" : "bg-inset text-ink-secondary")}
            >
              {t(phone.online ? "settings.phone.connected" : "settings.phone.notConnected")}
            </span>
          </SettingRow>
        ))}
      </SettingsRows>
    </SettingsGroup>
  );
}
