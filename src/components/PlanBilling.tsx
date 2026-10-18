import { useState } from "react";
import type { CloudAccountBridge, CloudPlanBridge } from "../../electron/cloud-account.mjs";
import { cloudAccountBridge, cloudCard, useCloudAccount } from "@/lib/cloud-account-view";
import { cloudPlanBridge, summaryFromCard, useCloudPagePlan, type CloudPlanSummary } from "@/lib/cloud-plan-summary";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { planSubtitle } from "./CloudAccountSettings";
import { CloudTrialRow } from "./CloudTrial";
import { SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

function PlanRow({ summary, failed, manage }: { summary: CloudPlanSummary | null; failed: boolean; manage: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const open = () => {
    if (busy) return;
    setBusy(true); setRefused(false);
    void manage().catch(() => setRefused(true)).finally(() => setBusy(false));
  };
  return (
    <SettingsGroup label={t("billing.title")} testId="plan">
      <SettingsRows data-plan-row={summary?.line ?? "none"}>
        <SettingRow title={planSubtitle(summary, failed)} subtitle={t("billing.onWeb")}
          message={refused ? <p role="alert" className="text-danger">{t("cloudAccount.actionFailed")}</p> : undefined}>
          <button type="button" disabled={busy} className="ui-button" onClick={open}>{t("cloudAccount.manage")}</button>
        </SettingRow>
      </SettingsRows>
    </SettingsGroup>
  );
}

function ThisMacPlan({ bridge }: { bridge: CloudAccountBridge }) {
  const { account, failed } = useCloudAccount(bridge);
  const summary = failed ? null : account ? summaryFromCard(cloudCard(account)) : null;
  if (!summary && !failed) return null;
  return <PlanRow summary={summary} failed={failed} manage={() => bridge.openDashboard()} />;
}

function CloudPagePlan({ bridge }: { bridge: CloudPlanBridge }) {
  const { summary, failed } = useCloudPagePlan(bridge);
  return <PlanRow summary={summary} failed={failed} manage={() => bridge.manage()} />;
}

export function PlanBilling() {
  const { state } = useStore();
  const account = cloudAccountBridge();
  const page = account ? undefined : cloudPlanBridge();
  return (
    <>
      {account ? <ThisMacPlan bridge={account} /> : page ? <CloudPagePlan bridge={page} /> : null}
      {!state.config?.cloudHome && (
        <SettingsRows data-cloud-trial-rows="" className="empty:hidden">
          <CloudTrialRow />
        </SettingsRows>
      )}
    </>
  );
}
