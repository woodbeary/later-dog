import { useEffect, useState } from "react";
import { Cloud } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { useStore } from "@/state/store";
import { buyOfferAllowed, cloudPlanLine, cloudPlanView, type CloudPlanView } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";

// later.dog sells no plan: there is no Pro card, no price and no store link.
// What remains is the plan a configured Cloud already verified for this
// computer, shown in Settings with the way to its own section. Without a
// Cloud in the build there is no bridge, and this renders nothing at all.

/** The plan as the native snapshot says; null without a bridge (a browser, a remote page). */
function useCloudPlan(): CloudPlanView | null {
  const bridge = window.laterdog?.remoteClient?.active ? undefined : window.laterdog?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    // Reads the native snapshot only; never initiates sign-in or a refresh.
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return bridge ? cloudPlanView(account) : null;
}

/** In Settings: someone with a plan (or one being linked, or one this app
 * cannot check right now) sees that plan and the way to it. Someone with
 * nothing to show is offered nothing: this build has no plan to sell. */
export function ProSettingsCard() {
  const { dispatch } = useStore();
  const view = useCloudPlan();
  if (!view || buyOfferAllowed(view)) return null;
  const line = cloudPlanLine(view);
  if (!line && view.kind !== "reauth") return null;
  return <section aria-label={t("settings.section.cloudAccount")} data-cloud-plan={view.kind} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline/50 p-3">
    <div className="flex items-center gap-3">
      <Cloud className="text-ink-secondary" size={18} aria-hidden="true" />
      <div><h3 className="text-[14px] font-semibold text-ink">{t("settings.section.cloudAccount")}</h3>
        <p className="mt-1 text-[12px] text-ink-secondary">{view.kind === "reauth" ? t("pro.reauthShort") : line}</p></div>
    </div>
    <button type="button" className="ui-button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" })}>{t("pro.openCloudSettings")}</button>
  </section>;
}
