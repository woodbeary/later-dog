// A build with no update feed (later.dog's releases are unsigned) cannot
// install updates itself, so the desktop app asks GitHub for the latest
// release instead (electron/release-check.mjs) and the update UI offers its
// page to download from. These are that offer's own pieces: the card that
// tells the person once per version, the About dialog's line, and the switch
// in Settings → General. The update entries in Settings and the profile menu
// read the same state through releaseOffer.
import { useState } from "react";
import { ArrowDownToLine, Sparkles, X } from "lucide-react";
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

// The card is told once per version: putting it away is remembered on this
// device, and a newer version brings it back.
const DISMISSED_KEY = "laterdog.release-notice.dismissed";

function dismissedVersion(): string | null {
  try {
    return globalThis.localStorage?.getItem(DISMISSED_KEY) ?? null;
  } catch {
    return null;
  }
}

function rememberDismissed(version: string): void {
  try {
    globalThis.localStorage?.setItem(DISMISSED_KEY, version);
  } catch {
    // Blocked storage: the card still goes away for this session.
  }
}

/** UpdateBanner's card, for a newer release this app cannot install. Download,
 * Later and the X all put it away for that version; the release stays on
 * offer in Settings, the profile menu and About. */
export function ReleaseNoticeCard({ release }: { release: ReleaseOffer }) {
  const [dismissed, setDismissed] = useState(dismissedVersion);
  if (dismissed === release.version) return null;
  const putAway = () => {
    rememberDismissed(release.version);
    setDismissed(release.version);
  };
  return (
    <div className="animate-panel-in fixed bottom-4 left-4 z-50 w-[300px] rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink">
            {t("releaseCheck.available", { app: brand().name, version: release.version })}
          </div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary">{t("releaseCheck.hint")}</div>
        </div>
        <button
          onClick={putAway}
          className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          title={t("releaseCheck.dismiss")}
          aria-label={t("releaseCheck.dismiss")}
        >
          <X size={14} />
        </button>
      </div>
      <div className="mt-2.5 flex gap-2">
        <button
          onClick={() => {
            putAway();
            void openExternalLink(release.url);
          }}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-1.5 text-[13px] font-medium text-white"
        >
          <ArrowDownToLine size={13} /> {t("releaseCheck.download")}
        </button>
        <button
          onClick={putAway}
          className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
        >
          {t("releaseCheck.later")}
        </button>
      </div>
    </div>
  );
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

/** Settings → General → Check for new versions. Only on this computer's page,
 * and only where the desktop app checks GitHub (no update feed, not dev). */
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
