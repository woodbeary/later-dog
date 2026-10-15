import { Zap } from "lucide-react";
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

export function RestBattery({ rest, now }: { rest: AccountRest; now: number }) {
  return (
    <span className="relative inline-flex shrink-0">
      <RechargeLine progress={rest.estimated ? null : rechargeProgress(rest, now)} />
      <Zap data-charging-bolt="" aria-hidden="true" size={9} strokeWidth={2.5} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 fill-current text-ink drop-shadow-sm" />
    </span>
  );
}

export function usageValueClass(used: number | undefined): string {
  const tone = used === undefined ? "good" : usageTone(used);
  return tone === "warning" || tone === "danger" ? USAGE_TEXT[tone] : "text-ink-secondary";
}

export function AccountChargeColumns({ used, rest, now }: { used?: number; rest?: AccountRest; now: number }) {
  const progress = rest && !rest.estimated ? rechargeProgress(rest, now) : null;
  const recharged = progress === null ? null : Math.round(progress * 100);
  const value = rest
    ? recharged === null ? "" : t("planUsage.percentLeft", { left: recharged })
    : used === undefined ? "" : t("planUsage.percentLeft", { left: usageLeft(used) });
  return (
    <>
      <span data-account-battery-column className="flex w-8 shrink-0 items-center">
        {rest ? <RestBattery rest={rest} now={now} /> : used === undefined ? null : <BatteryMeter used={used} />}
      </span>
      <span
        data-account-value-column
        data-account-charge={rest ? "recharging" : used === undefined ? undefined : usageLeft(used)}
        title={recharged === null ? undefined : t("accounts.recharged", { percent: recharged })}
        className={cn("w-10 shrink-0 truncate text-right text-[12px] tabular-nums", rest ? "text-ink-secondary" : usageValueClass(used))}
      >
        {value}
      </span>
    </>
  );
}

export function AccountCharge({ used, rest, now, className }: { used?: number; rest?: AccountRest; now: number; className?: string }) {
  if (rest) {
    const back = backAt(rest, now);
    return (
      <span data-account-charge="recharging" className={cn("flex min-w-0 shrink-[1000] items-center gap-2", className)}>
        <RestBattery rest={rest} now={now} />
        <span title={back} className="min-w-0 truncate text-[12px] tabular-nums text-ink-secondary">{back}</span>
      </span>
    );
  }
  if (used === undefined) return null;
  return (
    <span data-account-charge={usageLeft(used)} className={cn("flex shrink-0 items-center gap-2", className)}>
      <BatteryMeter used={used} />
      <span className={cn("w-9 text-right text-[12px] tabular-nums", usageValueClass(used))}>
        {t("planUsage.percentLeft", { left: usageLeft(used) })}
      </span>
    </span>
  );
}
