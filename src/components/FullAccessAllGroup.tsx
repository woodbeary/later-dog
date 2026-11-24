import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { SettingRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";

export interface FullAccessAllView {
  enabled: boolean;
  dogs: number;
  full: number;
}

export function FullAccessAllGroup() {
  const [view, setView] = useState<FullAccessAllView | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void api<FullAccessAllView>("/api/full-access-all", { timeoutMs: 5_000 }).then((next) => { if (alive) setView(next); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const toggle = async () => {
    if (!view || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      setView(await api<FullAccessAllView>("/api/full-access-all", { method: "PUT", body: JSON.stringify({ enabled: !view.enabled }) }));
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (!view) return null;
  return (
    <SettingsGroup label={t("settings.group.fullAccessAll")} testId="full-access-all">
      <SettingsRows>
        <SettingRow
          title={t("settings.fullAccessAll.title")}
          subtitle={t(view.enabled ? "settings.fullAccessAll.on" : "settings.fullAccessAll.off", { full: String(view.full), dogs: String(view.dogs) })}
          message={failed && <span role="alert" className="text-danger">{t("settings.fullAccessAll.error")}</span>}
        >
          <Switch checked={view.enabled} disabled={saving} aria-label={t("settings.fullAccessAll.title")} data-full-access-all={view.enabled ? "on" : "off"} onClick={() => void toggle()} />
        </SettingRow>
      </SettingsRows>
    </SettingsGroup>
  );
}
