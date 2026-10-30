import { useEffect, useState } from "react";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { botUsage, costCaption, formatUsd, hasFiniteCost } from "@/lib/usage";
import { IncludedUsage } from "./IncludedUsage";
import { PlanBilling } from "./PlanBilling";
import { UsageHistory, fetchUsage, usagePeriodRange, type UsageSummary } from "./UsageHistory";
import { UsageAccounts } from "./UsageAccounts";

export function UsageSection() {
  const { state } = useStore();
  const [soFar, setSoFar] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let current = true;
    fetchUsage(usagePeriodRange("year"), "bot")
      .then((next) => { if (current) setSoFar(next); })
      .catch(() => { if (current) setSoFar(null); });
    return () => { current = false; };
  }, []);
  const billings = new Set(state.bots
    .filter((bot) => !bot.hidden && botUsage(bot).turns > 0)
    .map((bot) => state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.snapshot.billing));
  const total = soFar?.total;
  const cost = total && hasFiniteCost(total.costUsd) ? total.costUsd : null;
  const caption = !total ? null
    : total.turns === 0 ? t("usage.empty")
    : cost === null ? t("usage.costUnknown")
    : t("usage.costLine", { caption: billings.size === 1 ? costCaption([...billings][0]) : t("usage.costMixed") });

  return (
    <>
      <PlanBilling />
      <UsageAccounts />
      <IncludedUsage />
      <section data-usage-cost="" className="flex flex-col gap-1.5">
        <h3 className="px-4 text-[12px] font-medium text-ink-secondary">{t("usage.costSoFar")}</h3>
        <div className="rounded-xl bg-card px-4 py-3">
          <div className="text-[22px] font-semibold text-ink">{cost === null ? "—" : formatUsd(cost)}</div>
          {caption && <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{caption}</p>}
        </div>
      </section>
      <UsageHistory />
    </>
  );
}
