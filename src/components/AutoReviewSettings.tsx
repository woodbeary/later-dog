import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { autoReviewOn } from "@/lib/auto-review";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { SettingRow, Switch } from "./SettingsPrimitives";

export const STILL_ASKS_FIRST: readonly LocaleKey[] = [
  "settings.autoReview.stillAsks.heel",
  "settings.autoReview.stillAsks.questions",
  "settings.autoReview.stillAsks.sends",
  "settings.autoReview.stillAsks.sandbox",
  "settings.autoReview.stillAsks.mac",
  "settings.autoReview.stillAsks.otherDogs",
  "settings.autoReview.stillAsks.macApps",
];

export function AutoReviewRow() {
  const { state, dispatch } = useStore();
  const on = autoReviewOn(state.config);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { autoReview: !on } }),
      });
      dispatch({ type: "configStatus", config });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.autoReview.title")}
      subtitle={t(on ? "settings.autoReview.hint" : "settings.autoReview.hintOff")}
      message={(failed || !on) && (
        <>
          {failed && <span role="alert" className="text-danger">{t("settings.autoReview.error")}</span>}
          {!on && (
            <div data-auto-review-still-asks="" className="text-ink-secondary">
              <p className="font-medium text-ink">{t("settings.autoReview.stillAsks")}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 leading-relaxed">
                {STILL_ASKS_FIRST.map((key) => <li key={key}>{t(key)}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    >
      <Switch checked={on} disabled={saving} aria-label={t("settings.autoReview.title")} data-auto-review-switch="" onClick={() => void toggle()} />
    </SettingRow>
  );
}
