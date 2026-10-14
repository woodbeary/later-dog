import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { backAt, rechargeProgress, RechargeLine, usageLeft, type AccountRest } from "./AccountCharge";
import { BAR_TONE, USAGE_TEXT, usageTone } from "./PlanUsage";

export function BatteryMeter({ used, label, className }: { used: number; label?: string; className?: string }) {
  const left = usageLeft(used);
  return (
    <span
      data-battery={left}
      role="meter"
      aria-label={label ?? t("planUsage.left", { left })}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={left}
      aria-valuetext={t("planUsage.left", { left })}
      className={cn("relative inline-flex h-3 w-7 shrink-0 rounded-[3px] border border-ink-tertiary/70 p-px after:absolute after:-right-1 after:top-1/2 after:h-1.5 after:w-0.5 after:-translate-y-1/2 after:rounded-r after:bg-ink-tertiary/70", className)}
    >
      <span className="relative block size-full overflow-hidden rounded-[1px]">
        <span className={cn("absolute inset-y-0 left-0 rounded-[1px] transition-[width] duration-500 motion-reduce:transition-none", BAR_TONE[usageTone(used)])} style={{ width: `${left}%` }} />
      </span>
    </span>
  );
}

export function AccountCharge({ used, rest, now, className }: { used?: number; rest?: AccountRest; now: number; className?: string }) {
  if (rest) {
    return (
      <span data-account-charge="recharging" className={cn("flex shrink-0 items-center gap-2", className)}>
        <RechargeLine progress={rest.estimated ? null : rechargeProgress(rest, now)} />
        <span className="text-[12px] tabular-nums text-ink-secondary">{backAt(rest, now)}</span>
      </span>
    );
  }
  if (used === undefined) return null;
  const tone = usageTone(used);
  return (
    <span data-account-charge={usageLeft(used)} className={cn("flex shrink-0 items-center gap-2", className)}>
      <BatteryMeter used={used} />
      <span className={cn("w-9 text-right text-[12px] tabular-nums", tone === "warning" || tone === "danger" ? USAGE_TEXT[tone] : "text-ink-secondary")}>
        {t("planUsage.percentLeft", { left: usageLeft(used) })}
      </span>
    </span>
  );
}
