import { Smartphone, Trash2 } from "lucide-react";

import { t } from "@/lib/i18n";
import type { PhoneSetupController } from "./PhoneSetupFlow";
import { Switch } from "./SettingsPrimitives";

export function lastSeenAgo(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 90) return t("remote.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("remote.time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("remote.time.hours", { count: hours });
  return t("remote.time.days", { count: Math.round(hours / 24) });
}

export function PairedPhones({ controller: c }: { controller: PhoneSetupController }) {
  const devices = c.state?.devices ?? [];
  if (devices.length === 0) return null;

  return (
    <section data-paired-phones="" className="mt-6 border-t border-hairline/40 pt-5">
      <div className="text-[12px] font-medium text-ink-secondary">{t("remote.devices.title")}</div>
      <ul className="mt-2 flex flex-col gap-2">
        {devices.map((device) => (
          <li key={device.id} data-paired-phone={device.id} className="rounded-xl bg-card px-4">
            <div className="flex items-center gap-3 py-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink-secondary">
                <Smartphone size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-ink">{device.name}</span>
                <span className="block text-[11.5px] text-ink-secondary">{t("remote.devices.lastSeen", { when: lastSeenAgo(device.lastSeenAt) })}</span>
              </span>
              <button
                type="button"
                data-paired-phone-remove={device.id}
                disabled={c.busy}
                onClick={() => void c.act((companion) => companion.revoke(device.id))}
                aria-label={t("remote.devices.remove", { name: device.name })}
                title={t("remote.devices.remove", { name: device.name })}
                className="shrink-0 rounded p-1.5 text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-40"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-hairline/40 py-3">
              <span>
                <span className="block text-[12.5px] text-ink">{t("remote.devices.allowView")}</span>
                <span className="mt-0.5 block text-[11.5px] text-ink-secondary">{t("remote.devices.allowViewDetail")}</span>
              </span>
              <Switch
                checked={device.cloudDesktopAccess}
                aria-label={t("remote.devices.viewAria", { name: device.name })}
                disabled={c.busy}
                onClick={() => void c.act((companion) => companion.cloudDesktop(device.id, !device.cloudDesktopAccess))}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-hairline/40 py-3">
              <span>
                <span className="block text-[12.5px] text-ink">{t("remote.devices.allowBrowser")}</span>
                <span className="mt-0.5 block text-[11.5px] text-ink-secondary">{t("remote.devices.allowBrowserDetail")}</span>
              </span>
              <Switch
                checked={device.browserControlAccess === true}
                aria-label={t("remote.devices.browserAria", { name: device.name })}
                disabled={c.busy}
                onClick={() => void c.act((companion) => companion.browserControl(device.id, !device.browserControlAccess))}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
