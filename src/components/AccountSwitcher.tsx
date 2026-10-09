import type { ReactNode } from "react";
import { Check } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { InstanceProviderMark } from "./ProviderIcons";
import { Switch } from "./SettingsPrimitives";
import { signedIn, useCarryOn } from "./AccountsPanel";
import { resetClock, resetDistance, UsageBar, usageLines, usageReading, usageTone, type PlanProvider, type PlanUsageReport, type UsageTone } from "./PlanUsage";

type Resting = Readonly<Record<string, { until: string }>> | undefined;

const RING_TONE: Record<UsageTone, string> = { accent: "text-accent", warning: "text-warning", danger: "text-danger" };

export function activeRest(resting: Resting, instanceId: string, now: number): { until: string } | undefined {
  const rest = resting?.[instanceId];
  return rest && Date.parse(rest.until) > now ? rest : undefined;
}

export function accountUsageLines(provider: PlanProvider | undefined, rest: { until: string } | undefined, now: number): string[] {
  return rest ? [t("accounts.resting", { time: resetClock(rest.until, now) })] : usageLines(provider, now);
}

export function UsageRing({ used, tone, children }: { used: number; tone: UsageTone; children: ReactNode }) {
  const clamped = Math.min(100, Math.max(0, used));
  const radius = 9;
  const length = 2 * Math.PI * radius;
  return (
    <span data-usage-ring={Math.round(clamped)} className="relative flex size-5 shrink-0 items-center justify-center">
      <svg aria-hidden="true" viewBox="0 0 20 20" className="absolute inset-0 size-5 -rotate-90">
        <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-control" />
        {clamped > 0 && (
          <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            strokeDasharray={length} strokeDashoffset={length * (1 - clamped / 100)} className={RING_TONE[tone]} />
        )}
      </svg>
      {children}
    </span>
  );
}

export function AccountSwitcher({ accounts, currentId, report, loading, now, resting, onPick }: {
  accounts: readonly InstanceInfo[];
  currentId: string;
  report: PlanUsageReport | null;
  loading: boolean;
  now: number;
  resting: Resting;
  onPick: (account: InstanceInfo) => void;
}) {
  const carryOn = useCarryOn();
  const kinds = accounts.map((account) => account.driverKind);
  const canCarryOn = kinds.some((kind, index) => kinds.indexOf(kind) !== index);
  return (
    <section data-account-switcher aria-label={t("accounts.title")} className="shrink-0 border-b border-hairline/40 py-1">
      <ul>
        {accounts.map((account) => {
          const provider = report?.providers.find((candidate) => candidate.id === account.instanceId);
          const rest = activeRest(resting, account.instanceId, now);
          const reading = rest ? null : usageReading(provider);
          const ready = signedIn(account);
          const current = account.instanceId === currentId;
          const when = reading ? resetDistance(reading.resetsAt, now) : null;
          const status = !ready ? t("accounts.signedOut")
            : rest ? t("accounts.resting", { time: resetClock(rest.until, now) })
            : reading ? [t("planUsage.used", { used: Math.round(reading.used) }), when ? t("planUsage.resetsIn", { when }) : null].filter(Boolean).join(" · ")
            : loading ? t("planUsage.loading") : "";
          return (
            <li key={account.instanceId}>
              <button
                type="button"
                data-account={account.instanceId}
                aria-pressed={current}
                onClick={() => onPick(account)}
                title={[account.displayName, ...accountUsageLines(provider, rest, now)].join("\n")}
                className={cn("flex w-full flex-col gap-1 px-3 py-1.5 text-left hover:bg-raised-hover", current && "bg-control/50")}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <InstanceProviderMark instance={account} size={14} />
                  <span className={cn("min-w-0 flex-1 truncate text-[13px]", ready ? "text-ink" : "text-ink-secondary")}>{account.displayName}</span>
                  {status && <span className={cn("shrink-0 text-[12px] tabular-nums", rest ? "text-warning" : "text-ink-secondary")}>{status}</span>}
                  <Check size={14} aria-hidden="true" className={cn("shrink-0 text-accent", !current && "invisible")} />
                </span>
                {reading && <UsageBar used={reading.used} label={`${account.displayName} · ${reading.label}`} />}
              </button>
            </li>
          );
        })}
      </ul>
      {canCarryOn && (
        <div className="flex items-center justify-between gap-3 px-3 pb-1.5 pt-1">
          <span className="min-w-0 text-[12px] text-ink-secondary">{t("accounts.carryOn")}</span>
          <Switch checked={carryOn.on} disabled={carryOn.saving} aria-label={t("accounts.carryOn")} onClick={() => void carryOn.set(!carryOn.on)} />
        </div>
      )}
      {carryOn.error && <p role="alert" className="px-3 pb-1.5 text-[12px] text-danger">{carryOn.error}</p>}
    </section>
  );
}

export function usageRingFor(provider: PlanProvider | undefined, rest: { until: string } | undefined): { used: number; tone: UsageTone } | null {
  if (rest) return { used: 100, tone: "danger" };
  const reading = usageReading(provider);
  return reading ? { used: reading.used, tone: usageTone(reading.used) } : null;
}
