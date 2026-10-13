import type { ReactNode } from "react";
import { Check, GripVertical } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { InstanceProviderMark } from "./ProviderIcons";
import { signedIn, useCarryOn } from "./AccountsPanel";
import { USAGE_TEXT, usageLines, usageReading, usageTone, type PlanProvider, type PlanUsageReport, type UsageTone } from "./PlanUsage";
import { backAt, rechargeProgress, restSummary, SleepingDog, usageLeft, type AccountRest } from "./AccountCharge";
import { useAccountDrag } from "./account-drag";

export { ACCOUNT_DRAG_TYPE, movedTo } from "./account-drag";

type Resting = Readonly<Record<string, AccountRest>> | undefined;

export interface UsageRingLevel {
  level: number;
  tone: UsageTone | "accent";
  charging?: boolean;
}

const RING_TONE: Record<UsageRingLevel["tone"], string> = {
  good: "text-success", caution: "text-caution", warning: "text-warning", danger: "text-danger", accent: "text-accent",
};

export function activeRest(resting: Resting, instanceId: string, now: number): AccountRest | undefined {
  const rest = resting?.[instanceId];
  return rest && Date.parse(rest.until) > now ? rest : undefined;
}

export function accountUsageLines(provider: PlanProvider | undefined, rest: AccountRest | undefined, now: number): string[] {
  return rest ? [restSummary(rest, now)] : usageLines(provider, now);
}

export function UsageRing({ level, tone, charging = false, children }: UsageRingLevel & { children: ReactNode }) {
  const clamped = Math.min(100, Math.max(0, level));
  const radius = 9;
  const length = 2 * Math.PI * radius;
  return (
    <span data-usage-ring={Math.round(clamped)} data-charging={charging || undefined} className="relative flex size-5 shrink-0 items-center justify-center">
      <svg aria-hidden="true" viewBox="0 0 20 20" className="absolute inset-0 size-5 -rotate-90">
        <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-control" />
        {clamped > 0 && (
          <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            strokeDasharray={length} strokeDashoffset={length * (1 - clamped / 100)} className={cn(RING_TONE[tone], charging && "recharge-pulse")} />
        )}
      </svg>
      {children}
    </span>
  );
}

export function accountInitials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => [...word][0]!.toUpperCase()).join("") || "?";
}

export function AccountBadge({ instance, ring }: { instance: InstanceInfo; ring: UsageRingLevel | null }) {
  const initials = accountInitials(instance.displayName);
  return (
    <span data-account-initials={initials} className="relative flex size-5 shrink-0 items-center justify-center">
      {ring ? <UsageRing {...ring}>{ring.charging ? <SleepingDog size={15} /> : <InstanceProviderMark instance={instance} size={12} />}</UsageRing>
        : <InstanceProviderMark instance={instance} size={15} />}
      <span aria-hidden="true" className="absolute -bottom-1 -right-1.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-ink px-[2.5px] text-[7.5px] font-semibold leading-none tracking-tight text-app ring-[1.5px] ring-card">
        {initials}
      </span>
    </span>
  );
}

export function shownAccounts(accounts: readonly InstanceInfo[], currentId: string): InstanceInfo[] {
  return accounts.filter((account) => account.instanceId === currentId || signedIn(account));
}

export function AccountSwitcher({ accounts, currentId, report, now, resting, onPick }: {
  accounts: readonly InstanceInfo[];
  currentId: string;
  report: PlanUsageReport | null;
  now: number;
  resting: Resting;
  onPick: (account: InstanceInfo) => void;
}) {
  const carryOn = useCarryOn();
  const listed = shownAccounts(accounts, currentId);
  const movable = (_account: InstanceInfo) => carryOn.canReorder && !carryOn.saving
    && listed.length > 1;
  const drag = useAccountDrag(listed.map((account) => ({ id: account.instanceId, kind: "account", movable: movable(account) })),
    (ids) => void carryOn.reorder(ids));
  const rows = drag.order.flatMap((id) => listed.filter((account) => account.instanceId === id));
  const grips = listed.some(movable);
  return (
    <section data-account-switcher aria-label={t("accounts.title")} className="shrink-0 py-1">
      {carryOn.auto && <p className="px-3 py-1 text-[11px] text-ink-secondary">{t("accounts.automatic")}</p>}
      <ul {...drag.list}>
        {rows.map((account) => {
          const id = account.instanceId;
          const provider = report?.providers.find((candidate) => candidate.id === id);
          const rest = activeRest(resting, id, now);
          const reading = rest ? null : usageReading(provider);
          const ring = usageRingFor(provider, rest, now);
          const current = id === currentId;
          const canMove = movable(account);
          const status = rest ? backAt(rest, now)
            : !signedIn(account) ? t("accounts.signedOut")
            : reading ? t("planUsage.left", { left: usageLeft(reading.used) }) : "";
          const low = reading ? usageTone(reading.used) : "good";
          return (
            <li
              key={id}
              data-account-row={id}
              {...drag.row(id)}
              className={cn("group flex items-center hover:bg-raised-hover", current && "bg-control/50", drag.dragging === id && "opacity-50")}
            >
              <button
                type="button"
                data-account={id}
                aria-pressed={current}
                aria-keyshortcuts={canMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                onClick={() => onPick(account)}
                onKeyDown={(event) => drag.step(event, id)}
                title={[account.displayName, ...accountUsageLines(provider, rest, now)].join("\n")}
                className={cn("flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus", grips ? "pr-1" : "pr-3")}
              >
                {ring ? (
                  <UsageRing {...ring}>{rest ? <SleepingDog size={15} /> : <InstanceProviderMark instance={account} size={12} />}</UsageRing>
                ) : (
                  <span className="flex size-5 shrink-0 items-center justify-center"><InstanceProviderMark instance={account} size={14} /></span>
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{account.displayName}</span>
                {status && <span className={cn("shrink-0 text-[12px] tabular-nums", rest ? "text-ink-secondary" : USAGE_TEXT[low])}>{status}</span>}
                <Check size={14} aria-hidden="true" className={cn("shrink-0 text-accent", !current && "invisible")} />
              </button>
              {grips && (
                <span
                  aria-hidden="true"
                  data-account-grip={canMove || undefined}
                  title={canMove ? t("accounts.dragHint") : undefined}
                  className={cn(
                    "flex w-6 shrink-0 cursor-grab items-center justify-center self-stretch text-ink-tertiary",
                    !canMove && "invisible",
                  )}
                >
                  <GripVertical size={12} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function usageRingFor(provider: PlanProvider | undefined, rest: AccountRest | undefined, now: number): UsageRingLevel | null {
  if (rest) return { level: Math.round((rechargeProgress(rest, now) ?? 0) * 100), tone: "accent", charging: true };
  const reading = usageReading(provider);
  return reading ? { level: usageLeft(reading.used), tone: usageTone(reading.used) } : null;
}
