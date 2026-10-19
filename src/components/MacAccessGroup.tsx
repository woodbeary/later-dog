import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

export type MacChoice = "always" | "ask" | "never";

export interface MacAccessMac {
  id: string;
  name: string;
  online: boolean;
  mode: MacChoice;
}

export interface MacAccessView {
  mode: MacChoice;
  macs: MacAccessMac[];
}

export const MAC_CHOICES: ReadonlyArray<{ mode: MacChoice; label: LocaleKey }> = [
  { mode: "always", label: "settings.mac.always" },
  { mode: "ask", label: "settings.mac.ask" },
  { mode: "never", label: "settings.mac.never" },
];

export function MacAccessGroup() {
  const [view, setView] = useState<MacAccessView | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api<MacAccessView>("/api/mac-access", { timeoutMs: 5_000 }).then((next) => { if (alive) setView(next); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const choose = async (mac: MacAccessMac, mode: MacChoice) => {
    if (saving || mac.mode === mode) return;
    setSaving(mac.id);
    setFailed(null);
    try {
      setView(await api<MacAccessView>("/api/mac-access", { method: "PUT", body: JSON.stringify({ computers: { [mac.id]: mode } }) }));
    } catch {
      setFailed(mac.id);
    } finally {
      setSaving(null);
    }
  };

  if (!view || view.macs.length === 0) return null;
  return (
    <SettingsGroup label={t("settings.group.macs")} testId="your-macs">
      <SettingsRows>
        {view.macs.map((mac) => (
          <SettingRow
            key={mac.id}
            title={mac.name}
            subtitle={t(mac.online ? "settings.mac.hint" : "settings.mac.offline")}
            message={failed === mac.id && <span role="alert" className="text-danger">{t("settings.mac.error")}</span>}
          >
            <div role="radiogroup" aria-label={t("settings.mac.choice", { name: mac.name })} data-mac-access={mac.mode} className="inline-flex shrink-0 rounded-full bg-inset p-1">
              {MAC_CHOICES.map((choice) => (
                <button
                  key={choice.mode}
                  type="button"
                  role="radio"
                  aria-checked={mac.mode === choice.mode}
                  data-mac-choice={choice.mode}
                  disabled={saving !== null}
                  onClick={() => void choose(mac, choice.mode)}
                  className={cn(
                    "rounded-full px-3 py-1 text-[13px] font-medium transition-colors disabled:cursor-not-allowed",
                    mac.mode === choice.mode ? "bg-raised text-ink shadow-sm" : "text-ink-secondary enabled:hover:text-ink",
                  )}
                >
                  {t(choice.label)}
                </button>
              ))}
            </div>
          </SettingRow>
        ))}
      </SettingsRows>
    </SettingsGroup>
  );
}
