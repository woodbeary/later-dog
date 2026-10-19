import { useRef, useState } from "react";
import type { CloudAccountBridge, CloudAccountState, CloudPlanBridge } from "../../electron/cloud-account.mjs";
import { cloudAccountBridge, cloudCard, homeStatusKey, useCloudAccount, type CloudCard, type CloudPlanLine } from "@/lib/cloud-account-view";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useCloudPagePlan, type CloudPlanSummary } from "@/lib/cloud-plan-summary";
import { CloudSignInForm } from "./CloudSignInForm";
import { SettingRow } from "./SettingsPrimitives";

const PLAN_LINE: Record<CloudPlanLine, LocaleKey> = {
  beta: "cloudAccount.plan.beta",
  paid: "cloudAccount.plan.paid",
  full: "cloudAccount.plan.full",
  inactive: "cloudAccount.plan.inactive",
};

const time = (value: number) => new Intl.DateTimeFormat(activeLocale(), { timeStyle: "short" }).format(new Date(value));
const OPEN_ATTEMPTS = 5;
const OPEN_RETRY_MS = 5_000;

export function planSubtitle(summary: CloudPlanSummary | null, failed: boolean): string {
  if (!summary) return t(failed ? "cloudAccount.unreachable" : "cloudAccount.loading");
  if (summary.signIn) return t("cloudAccount.reauth");
  if (!summary.line) return t(summary.checking ? "cloudAccount.checking" : "cloudAccount.plan.inactive");
  const line = t(PLAN_LINE[summary.line]);
  return summary.checking ? `${line} · ${t("cloudAccount.checking")}` : line;
}

function CloudPageAccount({ plan }: { plan: CloudPlanBridge }) {
  const { summary, failed: loadFailed } = useCloudPagePlan(plan);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirm = confirming && <div role="group" aria-label={t("cloudAccount.signOut")} data-cloud-signout-confirm className="rounded-lg bg-inset p-3">
    <p className="text-[13px] leading-relaxed text-ink">{t("cloudAccount.signOutConfirm")}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" autoFocus className="ui-button" onClick={() => setConfirming(false)}>{t("cloudAccount.keep")}</button>
      <button type="button" className="ui-button text-danger" onClick={() => { setFailed(false); void plan.signOut().catch(() => setFailed(true)); }}>{t("cloudAccount.signOut")}</button>
    </div>
  </div>;
  return <div data-cloud-account="on-cloud" data-cloud-plan={summary?.line ?? undefined}>
    <SettingRow title={summary?.email ?? t("settings.section.cloudAccount")} subtitle={planSubtitle(summary, loadFailed)}
      message={confirm || (failed ? <p role="alert" className="text-danger">{t("cloudAccount.actionFailed")}</p> : undefined)}>
      {!confirming && <button type="button" className="ui-button" onClick={() => setConfirming(true)}>{t("cloudAccount.signOut")}</button>}
    </SettingRow>
  </div>;
}

export function cloudAccountShown(): boolean {
  return Boolean(cloudAccountBridge() || (typeof window !== "undefined" && window.laterdog?.cloudPlan));
}

export function CloudAccountSettings() {
  const bridge = cloudAccountBridge();
  if (!bridge) {
    const plan = window.laterdog?.cloudPlan;
    return plan ? <CloudPageAccount plan={plan} /> : null;
  }
  return <SignedInCard bridge={bridge} />;
}

function SignedInCard({ bridge }: { bridge: CloudAccountBridge }) {
  const { account, failed: loadFailed, accept } = useCloudAccount(bridge);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [waking, setWaking] = useState(false);
  const pending = useRef(false);
  const perform = (action: () => Promise<CloudAccountState>, onError?: () => void) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false);
    void action().then((next) => { accept(next); if (next.status === "signed-out") setConfirming(false); })
      .catch(() => (onError ? onError() : setFailed(true)))
      .finally(() => { pending.current = false; setBusy(false); });
  };
  const openHome = () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false); setOpenFailed(false);
    void (async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          accept(await bridge.connectHome());
          setWaking(false);
          return;
        } catch {
          if (attempt >= OPEN_ATTEMPTS) { setWaking(false); setOpenFailed(true); return; }
          setWaking(true);
          await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS));
        }
      }
    })().finally(() => { pending.current = false; setBusy(false); });
  };
  const card: CloudCard = loadFailed ? { kind: "unreachable", email: null, note: "cloudAccount.unreachable" } : cloudCard(account);
  const error = failed ? <p role="alert" className="text-danger">{t("cloudAccount.actionFailed")}</p> : undefined;
  const signOut = <button type="button" disabled={busy} className="ui-button" onClick={() => setConfirming(true)}>{t("cloudAccount.signOut")}</button>;
  const confirm = confirming && <div role="group" aria-label={t("cloudAccount.signOut")} data-cloud-signout-confirm className="rounded-lg bg-inset p-3">
    <p className="text-[13px] leading-relaxed text-ink">{t("cloudAccount.signOutConfirm")}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" autoFocus disabled={busy} className="ui-button" onClick={() => setConfirming(false)}>{t("cloudAccount.keep")}</button>
      <button type="button" disabled={busy} className="ui-button text-danger" onClick={() => perform(() => bridge.signOut())}>{t("cloudAccount.signOut")}</button>
    </div>
  </div>;

  if (card.kind === "loading") {
    return <div data-cloud-account="loading">
      <SettingRow title={t("settings.section.cloudAccount")} subtitle={t("cloudAccount.loading")}>{null}</SettingRow>
    </div>;
  }
  if (card.kind === "signed-out") {
    return <div data-cloud-account="signed-out">
      <SettingRow title={t("cloudAccount.notSignedIn")} subtitle={<>{t("cloudAccount.intro")}{card.note && <span className="mt-1 block text-ink">{t(card.note)}</span>}</>}>{null}</SettingRow>
      <div className="mx-auto w-full max-w-[360px] px-4 pb-4"><CloudSignInForm bridge={bridge} onSignedIn={accept} /></div>
    </div>;
  }
  if (card.kind === "connecting") {
    const check = card.code ? <>{t("cloudAccount.codeCheck")} <code dir="ltr" data-cloud-code className="select-all font-semibold tracking-widest text-ink">{card.code}</code>
      {card.until && <span className="block">{t("cloudAccount.codeUntil", { time: time(card.until) })}</span>}</> : t("cloudAccount.opening");
    return <div data-cloud-account="connecting">
      <SettingRow title={t("cloudAccount.continueInBrowser")} subtitle={check} message={error}>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <button type="button" disabled={busy} className="ui-button" onClick={() => perform(() => bridge.reopen())}>{t("cloudAccount.openAgain")}</button>
          <button type="button" disabled={busy} className="ui-button" onClick={() => perform(() => bridge.cancel())}>{t("common.cancel")}</button>
        </div>
      </SettingRow>
    </div>;
  }
  if (card.kind === "reauth" || card.kind === "unreachable") {
    const note = card.kind === "reauth" ? "cloudAccount.reauth" : card.note;
    return <div data-cloud-account={card.kind}>
      <SettingRow title={card.email ?? t("settings.section.cloudAccount")} subtitle={t(note)} message={confirm || error}>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {card.kind === "unreachable" && <button type="button" disabled={busy} className="ui-button" onClick={() => perform(() => bridge.refresh())}>{t("cloudAccount.tryAgain")}</button>}
          {!confirming && signOut}
        </div>
      </SettingRow>
      {card.kind === "reauth" && <div className="mx-auto w-full max-w-[360px] px-4 pb-4"><CloudSignInForm bridge={bridge} onSignedIn={accept} /></div>}
    </div>;
  }
  const home = card.home;
  return <div data-cloud-account="signed-in" data-cloud-plan={card.plan}>
    <SettingRow title={card.email} subtitle={<>{t(PLAN_LINE[card.plan])}{card.checking && <span className="ms-2">{t("cloudAccount.checking")}</span>}</>} message={confirm || error}>
      {!confirming && signOut}
    </SettingRow>
    {home && <SettingRow title={t("cloudAccount.myCloud")}
      subtitle={<span role="status" data-cloud-home={waking ? "waking" : home.status}>{waking ? t("cloudAccount.home.waking") : t(homeStatusKey(home), { time: home.retryAt ? time(home.retryAt) : "" })}</span>}
      message={openFailed ? <p role="alert" className="text-danger">{t("cloudAccount.openFailed")}</p> : undefined}>
      {home.status === "ready" && <button type="button" disabled={busy} className="ui-button" onClick={openHome}>{t("cloudHome.connect")}</button>}
    </SettingRow>}
  </div>;
}
