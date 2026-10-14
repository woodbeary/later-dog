import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { resetClock, resetDistance } from "@/lib/reset-time";
import { BatteryMeter } from "./AccountBattery";
import { RestCharge, usageLeft, type AccountRest } from "./AccountCharge";
import { USAGE_TEXT, usageTone, type PlanProvider } from "./PlanUsage";

export interface UsageWindowLine {
  key: "fiveHour" | "weekly";
  label: string;
  used: number;
  when: string | null;
  at: string | null;
}

export function usageWindowLines(provider: PlanProvider | undefined, now: number): UsageWindowLine[] {
  if (!provider?.ok) return [];
  return ([["fiveHour", t("planUsage.fiveHour"), provider.fiveHour], ["weekly", t("planUsage.weekly"), provider.weekly]] as const).flatMap(([key, label, window]) =>
    window.available && window.usedPercent != null
      ? [{ key, label, used: window.usedPercent, when: resetDistance(window.resetsAt, now), at: window.resetsAt && resetDistance(window.resetsAt, now) ? resetClock(window.resetsAt, now) : null }]
      : []);
}

export function AccountUsageCard({ name, plan, provider, rest, now, onManage, className }: {
  name: string;
  plan?: string | null;
  provider: PlanProvider | undefined;
  rest: AccountRest | undefined;
  now: number;
  onManage: () => void;
  className?: string;
}) {
  const windows = usageWindowLines(provider, now);
  return (
    <section data-account-usage-card aria-label={name} className={cn("w-64 px-3.5 pb-1.5 pt-3", className)}>
      <p className="flex items-baseline justify-between gap-3 text-[13px] font-medium text-ink">
        <span className="min-w-0 truncate">{name}</span>
        {plan && <span className="shrink-0 text-[12px] font-normal text-ink-secondary">{plan}</span>}
      </p>
      <div className="mt-2.5 flex flex-col gap-2.5">
        {rest ? <RestCharge rest={rest} now={now} /> : windows.length === 0 ? (
          <p className="text-[12px] text-ink-secondary">{t("planUsage.none")}</p>
        ) : windows.map((window) => {
          const tone = usageTone(window.used);
          return (
            <div key={window.key} data-usage-window={window.key} className="flex flex-col gap-1">
              <p className="flex items-center justify-between gap-2 text-[12px] tabular-nums">
                <span className="text-ink-secondary">{window.label}</span>
                <span className="flex items-center gap-2">
                  <BatteryMeter used={window.used} label={window.label} />
                  <span className={cn("w-9 text-right font-medium", tone === "warning" || tone === "danger" ? USAGE_TEXT[tone] : "text-ink")}>
                    {t("planUsage.percentLeft", { left: usageLeft(window.used) })}
                  </span>
                </span>
              </p>
              {window.when && (
                <p data-usage-reset className="text-[11.5px] text-ink-tertiary">
                  {t("planUsage.resetsIn", { when: window.when })}{window.at ? ` · ${window.at}` : ""}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        role="menuitem"
        data-account-manage-usage
        onClick={onManage}
        className="-mx-2 mt-2.5 flex w-[calc(100%+1rem)] items-center rounded-lg border-t border-hairline/40 px-2 py-2 text-left text-[13px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
      >
        {t("accounts.manageUsage")}
      </button>
    </section>
  );
}
