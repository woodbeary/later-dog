import { DEFAULT_DOG_COLOR, type DogColor } from "@/lib/mascot";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { resetClock, resetDistance } from "@/lib/reset-time";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import { DogAvatar } from "./Avatar";

export interface AccountRest {
  until: string;
  since?: string;
  estimated?: boolean;
}

export function rechargeProgress(rest: AccountRest, now: number): number | null {
  if (rest.estimated) return null;
  const until = Date.parse(rest.until);
  const since = rest.since ? Date.parse(rest.since) : Number.NaN;
  if (!Number.isFinite(until) || !Number.isFinite(since) || until <= since) return null;
  return Math.min(1, Math.max(0, (now - since) / (until - since)));
}

export function usageLeft(used: number): number {
  return Math.min(100, Math.max(0, 100 - Math.round(used)));
}

export function backAt(rest: AccountRest, now: number): string {
  return rest.estimated ? t("accounts.recharging") : t("accounts.backAt", { time: resetClock(rest.until, now) });
}

export function restSummary(rest: AccountRest, now: number): string {
  const when = rest.estimated ? null : resetDistance(rest.until, now);
  return [backAt(rest, now), when ? t("accounts.inWhen", { when }) : null].filter(Boolean).join(" · ");
}

export function SleepingDog({ size = 16, color = DEFAULT_DOG_COLOR, bodyId, className }: {
  size?: number;
  color?: DogColor;
  bodyId?: MascotBodyId;
  className?: string;
}) {
  return (
    <span
      data-sleeping-dog=""
      aria-hidden="true"
      className={cn("dog-snooze relative inline-flex shrink-0", className)}
      style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.42)) }}
    >
      <DogAvatar color={color} bodyId={bodyId} state="sleeping" size={size} trackPointer={false} />
    </span>
  );
}

export function RechargeLine({ progress, className }: { progress: number | null; className?: string }) {
  const percent = progress === null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <span data-recharge={percent ?? "unknown"} role="progressbar" aria-label={t("accounts.recharging")}
      aria-valuemin={percent === null ? undefined : 0} aria-valuemax={percent === null ? undefined : 100}
      aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? undefined : t("accounts.recharged", { percent })}
      className={cn("relative inline-flex h-3 w-7 shrink-0 rounded-[3px] border border-accent/70 p-px text-accent after:absolute after:-right-1 after:top-1/2 after:h-1.5 after:w-0.5 after:-translate-y-1/2 after:rounded-r after:bg-current", className)}>
      <span className="relative block size-full overflow-hidden rounded-[1px] bg-accent/10">
        <span className={cn("recharge-fill absolute inset-0 origin-left bg-accent", percent === null && "opacity-40")}
          style={{ transform: `scaleX(${(percent ?? 100) / 100})` }} />
        <span aria-hidden="true" className="recharge-sheen absolute inset-0 bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      </span>
    </span>
  );
}

export function RestCharge({ rest, now }: { rest: AccountRest; now: number }) {
  return (
    <div data-rest-charge="" className="flex items-center gap-3">
      <SleepingDog size={26} className="mt-1" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="flex min-w-0 items-baseline justify-between gap-3 text-[12px]">
          <span className="shrink-0 font-medium text-ink">{t("accounts.recharging")}</span>
          <span className="truncate tabular-nums text-ink-secondary">{restSummary(rest, now)}</span>
        </p>
        <RechargeLine progress={rechargeProgress(rest, now)}  />
      </div>
    </div>
  );
}
