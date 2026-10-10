import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, GripVertical } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { InstanceProviderMark } from "./ProviderIcons";
import { Switch } from "./SettingsPrimitives";
import { signedIn, useCarryOn } from "./AccountsPanel";
import { resetClock, usageLines, usageReading, usageTone, type PlanProvider, type PlanUsageReport, type UsageTone } from "./PlanUsage";

type Resting = Readonly<Record<string, { until: string }>> | undefined;

const RING_TONE: Record<UsageTone, string> = { accent: "text-accent", warning: "text-warning", danger: "text-danger" };

export const ACCOUNT_DRAG_TYPE = "application/x-laterdog-account";

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

export function shownAccounts(accounts: readonly InstanceInfo[], currentId: string): InstanceInfo[] {
  return accounts.filter((account) => account.instanceId === currentId || signedIn(account));
}

export function movedTo(order: readonly string[], id: string, to: number): string[] {
  const next = order.filter((other) => other !== id);
  next.splice(to, 0, id);
  return next;
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
  const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);
  const listed = shownAccounts(accounts, currentId);
  const ids = listed.map((account) => account.instanceId);
  const kindOf = (id: string | undefined) => listed.find((account) => account.instanceId === id)?.driverKind;
  const rows = (drag?.order ?? ids).flatMap((id) => listed.filter((account) => account.instanceId === id));
  const movable = (account: InstanceInfo) => carryOn.canReorder && !carryOn.saving
    && listed.filter((other) => other.driverKind === account.driverKind).length > 1;
  const grips = listed.some(movable);
  const step = (event: KeyboardEvent<HTMLButtonElement>, account: InstanceInfo) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || !movable(account)) return;
    event.preventDefault();
    const to = ids.indexOf(account.instanceId) + (event.key === "ArrowUp" ? -1 : 1);
    if (kindOf(ids[to]) === account.driverKind) void carryOn.reorder(movedTo(ids, account.instanceId, to));
  };
  const drop = () => {
    if (drag && drag.order.join("\n") !== ids.join("\n")) void carryOn.reorder(drag.order);
    setDrag(null);
  };
  return (
    <section data-account-switcher aria-label={t("accounts.title")} className="shrink-0 py-1">
      <ul
        onDragOver={(event) => {
          if (!drag) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          if (!drag) return;
          event.preventDefault();
          drop();
        }}
      >
        {rows.map((account) => {
          const id = account.instanceId;
          const provider = report?.providers.find((candidate) => candidate.id === id);
          const rest = activeRest(resting, id, now);
          const reading = rest ? null : usageReading(provider);
          const ring = usageRingFor(provider, rest);
          const current = id === currentId;
          const canMove = movable(account);
          const status = rest ? t("accounts.resting", { time: resetClock(rest.until, now) })
            : !signedIn(account) ? t("accounts.signedOut")
            : reading ? t("planUsage.used", { used: Math.round(reading.used) }) : "";
          return (
            <li
              key={id}
              data-account-row={id}
              draggable={canMove || undefined}
              onDragStart={(event) => {
                if (!canMove) return;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(ACCOUNT_DRAG_TYPE, id);
                setDrag({ id, order: ids });
              }}
              onDragOver={() => {
                const at = drag ? drag.order.indexOf(id) : -1;
                if (!drag || drag.id === id || at < 0 || kindOf(drag.id) !== account.driverKind) return;
                setDrag({ id: drag.id, order: movedTo(drag.order, drag.id, at) });
              }}
              onDragEnd={() => setDrag(null)}
              className={cn("group flex items-center hover:bg-raised-hover", current && "bg-control/50", drag?.id === id && "opacity-50")}
            >
              <button
                type="button"
                data-account={id}
                aria-pressed={current}
                aria-keyshortcuts={canMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                onClick={() => onPick(account)}
                onKeyDown={(event) => step(event, account)}
                title={[account.displayName, ...accountUsageLines(provider, rest, now)].join("\n")}
                className={cn("flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus", grips ? "pr-1" : "pr-3")}
              >
                {ring ? (
                  <UsageRing used={ring.used} tone={ring.tone}><InstanceProviderMark instance={account} size={12} /></UsageRing>
                ) : (
                  <span className="flex size-5 shrink-0 items-center justify-center"><InstanceProviderMark instance={account} size={14} /></span>
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{account.displayName}</span>
                {status && <span className={cn("shrink-0 text-[12px] tabular-nums", rest ? "text-warning" : "text-ink-secondary")}>{status}</span>}
                <Check size={14} aria-hidden="true" className={cn("shrink-0 text-accent", !current && "invisible")} />
              </button>
              {grips && (
                <span
                  aria-hidden="true"
                  data-account-grip={canMove || undefined}
                  title={canMove ? t("accounts.dragHint") : undefined}
                  className={cn(
                    "flex w-6 shrink-0 cursor-grab items-center justify-center self-stretch text-ink-tertiary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
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
      <div className="flex items-center justify-between gap-3 px-3 pb-1.5 pt-1">
        <span className="min-w-0 text-[12px] text-ink-secondary">{t("accounts.carryOn")}</span>
        <Switch checked={carryOn.on} disabled={carryOn.saving} aria-label={t("accounts.carryOn")} onClick={() => void carryOn.set(!carryOn.on)} />
      </div>
      {carryOn.error && <p role="alert" className="px-3 pb-1.5 text-[12px] text-danger">{carryOn.error}</p>}
    </section>
  );
}

export function usageRingFor(provider: PlanProvider | undefined, rest: { until: string } | undefined): { used: number; tone: UsageTone } | null {
  if (rest) return { used: 100, tone: "danger" };
  const reading = usageReading(provider);
  return reading ? { used: reading.used, tone: usageTone(reading.used) } : null;
}
