import { useState } from "react";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { brand } from "../lib/brand";
import { SettingRow, Switch } from "./SettingsPrimitives";

export type ReleaseOffer = NonNullable<UpdaterState["available"]>;

/** The newer release to download, while the updater has nothing else going on. */
export function releaseOffer(state: UpdaterState | null | undefined): ReleaseOffer | null {
  return state?.status === "idle" && state.available ? state.available : null;
}

/** The person switched checking off, so nothing here can look for a new version. */
export function releaseChecksOff(state: UpdaterState | null | undefined): boolean {
  return state?.status === "idle" && state.releaseCheck === "off";
}

/** About's line under the version: the newer release, and its Download. */
export function AboutReleaseLine() {
  const release = releaseOffer(useUpdaterState());
  if (!release) return null;
  return (
    <p className="mt-2 text-[13px] text-ink">
      {t("releaseCheck.available", { app: brand().name, version: release.version })}
      {" · "}
      <button type="button" onClick={() => void openExternalLink(release.url)} className="text-accent hover:underline">
        {t("releaseCheck.download")}
      </button>
    </p>
  );
}

export function ReleaseCheckRow() {
  const state = useUpdaterState();
  const bridge = window.laterdog?.releaseCheck;
  // The switch moves on the click; the state main sends back settles it.
  const [saving, setSaving] = useState<boolean | null>(null);
  if (!state?.releaseCheck || !bridge) return null;
  const on = saving ?? state.releaseCheck === "on";
  return (
    <SettingRow title={t("releaseCheck.settings.title")} subtitle={t("releaseCheck.settings.subtitle")}>
      <Switch
        checked={on}
        disabled={saving !== null}
        aria-label={t("releaseCheck.settings.aria")}
        onClick={() => {
          const next = !on;
          setSaving(next);
          void bridge
            .setEnabled(next)
            .catch(() => {})
            .finally(() => setSaving(null));
        }}
      />
    </SettingRow>
  );
}
