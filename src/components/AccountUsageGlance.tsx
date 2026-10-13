import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";
import { RestCharge, usageLeft, type AccountRest } from "./AccountCharge";
import { resetDistance, USAGE_TEXT, UsageBar, usageTone, type PlanProvider } from "./PlanUsage";
import { InstanceProviderMark } from "./ProviderIcons";

export function AccountUsageGlance({ instance, provider, rest, now, onDetails }: {
  instance: InstanceInfo;
  provider: PlanProvider | undefined;
  rest: AccountRest | undefined;
  now: number;
  onDetails: () => void;
}) {
  const windows = provider?.ok
    ? ([[t("planUsage.fiveHour"), provider.fiveHour], [t("planUsage.weekly"), provider.weekly]] as const).flatMap(([label, window]) =>
      window.available && window.usedPercent != null ? [{ label, used: window.usedPercent, when: resetDistance(window.resetsAt, now) }] : [])
    : [];
  if (!rest && windows.length === 0) return null;
  return (
    <section data-account-usage aria-label={t("settings.section.usage")} className="shrink-0 border-b border-hairline/40 px-3.5 pb-3 pt-2.5">
      <div className="mb-2.5 flex items-center gap-2">
        <InstanceProviderMark instance={instance} size={14} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{instance.displayName}</span>
        <button
          type="button"
          data-account-usage-details
          onClick={onDetails}
          className="-mr-1.5 flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[12px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {t("accounts.usageDetails")}
          <ChevronRight size={12} aria-hidden="true" />
        </button>
      </div>
      {rest ? <RestCharge rest={rest} now={now} /> : (
        <div className="flex flex-col gap-2.5">
          {windows.map((window) => {
            const tone = usageTone(window.used);
            return (
              <div key={window.label} data-usage-window={window.label} className="flex flex-col gap-1.5">
                <p className="flex items-baseline justify-between gap-2 text-[12px] tabular-nums">
                  <span className="min-w-0 truncate text-ink-secondary">
                    {window.when ? `${window.label} · ${t("planUsage.resetsIn", { when: window.when })}` : window.label}
                  </span>
                  <span className={cn("shrink-0 font-medium", tone === "warning" || tone === "danger" ? USAGE_TEXT[tone] : "text-ink")}>
                    {t("planUsage.left", { left: usageLeft(window.used) })}
                  </span>
                </p>
                <UsageBar used={window.used} label={window.label} className="h-1.5" />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
