import { useStore } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { t } from "@/lib/i18n";
import { botUsage, costCaption, formatTokens, formatUsd, hasFiniteCost, headlineTokens, sumUsage, tokensColumnLabel, usageDetail } from "@/lib/usage";
import { UsageHistory } from "./UsageHistory";
import { PlanUsage } from "./PlanUsage";

const label = "px-4 text-[12px] font-medium text-ink-secondary";
const columns = "grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5";

export function UsageSection() {
  const { state } = useStore();
  const rows = state.bots
    .filter((bot) => !bot.hidden)
    .map((bot) => ({
      bot,
      usage: botUsage(bot),
      billing: state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.snapshot.billing,
    }))
    .filter((row) => row.usage.turns > 0)
    .sort((a, b) => {
      const costOf = (value: number | null | undefined) => (hasFiniteCost(value) ? value : Number.NEGATIVE_INFINITY);
      return costOf(b.usage.costUsd) - costOf(a.usage.costUsd) || headlineTokens(b.usage) - headlineTokens(a.usage);
    });
  const total = sumUsage(rows.map((row) => row.usage));
  const billings = new Set(rows.map((row) => row.billing));
  const cost = hasFiniteCost(total.costUsd) ? total.costUsd : null;
  const caption = rows.length === 0
    ? t("usage.empty")
    : cost === null
      ? t("usage.costUnknown")
      : t("usage.costLine", { caption: billings.size === 1 ? costCaption([...billings][0]) : t("usage.costMixed") });

  return (
    <>
      <PlanUsage />
      <section data-usage-cost="" className="flex flex-col gap-1.5">
        <h3 className={label}>{t("usage.costSoFar")}</h3>
        <div className="rounded-xl bg-card px-4 py-3">
          <div className="text-[22px] font-semibold tabular-nums text-ink">{cost === null ? "—" : formatUsd(cost)}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{caption}</p>
        </div>
      </section>
      {rows.length > 0 && (
        <section data-usage-dogs="" className="flex flex-col gap-1.5">
          <h3 className={label}>{t("usage.byDog")}</h3>
          <div className="rounded-xl bg-card px-4 py-3">
            <div className={`${columns} border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary`}>
              <span>{t("usage.colBot")}</span>
              <span className="text-right">{t("usage.colTurns")}</span>
              <span className="text-right">{tokensColumnLabel(total)}</span>
              <span className="text-right">{t("usage.colCost")}</span>
            </div>
            {rows.map(({ bot, usage }) => (
              <div key={bot.id} data-usage-dog={bot.id} className={`${columns} border-b border-hairline/20 py-2 text-[13px]`}>
                <span className="flex min-w-0 items-center gap-2 text-ink">
                  <BotAvatar bot={bot} state="idle" size={22} animated={false} />
                  <span className="truncate">{bot.name}</span>
                </span>
                <span className="text-right tabular-nums text-ink-secondary">{usage.turns}</span>
                <span className="text-right tabular-nums text-ink" title={usageDetail(usage)}>{formatTokens(headlineTokens(usage))}</span>
                <span className="text-right tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : <span className="text-ink-secondary">—</span>}</span>
              </div>
            ))}
            <div className={`${columns} pt-2.5 text-[13px] font-medium text-ink`}>
              <span>{t("usage.allBots")}</span>
              <span className="text-right tabular-nums">{total.turns}</span>
              <span className="text-right tabular-nums" title={usageDetail(total)}>{formatTokens(headlineTokens(total))}</span>
              <span className="text-right tabular-nums">{cost === null ? "—" : formatUsd(cost)}</span>
            </div>
          </div>
        </section>
      )}
      <UsageHistory />
    </>
  );
}
