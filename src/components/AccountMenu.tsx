import { Check, GripVertical, Plus, Settings } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";
import { InstanceProviderMark } from "./ProviderIcons";
import { resetClock } from "@/lib/reset-time";
import { backAt, SleepingDog, type AccountRest } from "./AccountCharge";
import { AccountChargeColumns } from "./AccountBattery";
import { usageReading, type PlanProvider } from "./PlanUsage";
import { useAccountDrag } from "./account-drag";

export interface AccountMenuRow {
  instance: InstanceInfo;
  label: string;
  selected: boolean;
  movable?: boolean;
  provider?: PlanProvider;
  rest?: AccountRest;
  inUse?: boolean;
  signIn?: boolean;
}

export const ACCOUNT_MENU_WIDTH = 384;

export function activeRowId(rows: readonly AccountMenuRow[]): string | undefined {
  return (rows.find((row) => row.inUse) ?? rows.find((row) => row.selected))?.instance.instanceId;
}

export function restStatus(rest: AccountRest, selected: boolean, now: number): string {
  if (!selected || rest.estimated) return backAt(rest, now);
  return t("accounts.restingBackAt", { time: resetClock(rest.until, now) });
}

export function AccountMenu({ rows, onPick, onAdd, onReorder, onSettings, auto = false, now = Date.now() }: {
  rows: readonly AccountMenuRow[];
  onSettings?: () => void;
  auto?: boolean;
  now?: number;
  onPick: (instance: InstanceInfo) => void;
  onAdd?: () => void;
  onReorder?: (ids: string[]) => void;
}) {
  const drag = useAccountDrag(
    rows.map((row) => ({ id: row.instance.instanceId, kind: row.movable ? "account" : `fixed:${row.instance.instanceId}`, movable: Boolean(!auto && onReorder && row.movable) })),
    (ids) => onReorder?.(ids),
  );
  const activeId = activeRowId(rows);
  const shown = drag.order.flatMap((id) => rows.filter((row) => row.instance.instanceId === id)).filter((row, index, all) =>
    all.findIndex((other) => other.instance.instanceId === row.instance.instanceId) === index);
  const grips = shown.some((row) => drag.movable(row.instance.instanceId));
  return (
    <div data-account-menu role="menu" aria-label={t("accounts.title")} className="relative flex min-h-0 flex-col">
      <div className="flex min-h-0 flex-col overflow-y-auto p-1" {...drag.list}>
      {auto && <p data-account-managed className="px-2.5 py-1.5 text-[11px] text-ink-secondary">{t("accounts.automatic")}</p>}
      {shown.map((row) => {
        const id = row.instance.instanceId;
        const canMove = drag.movable(id);
        const reading = usageReading(row.provider);
        const active = id === activeId;
        const status = row.rest ? restStatus(row.rest, row.selected, now)
          : reading && reading.used >= 100 && reading.resetsAt ? t("accounts.backAt", { time: resetClock(reading.resetsAt, now) }) : "";
        return (
          <div key={id} role="none" {...drag.row(id)} className={cn("group", drag.dragging === id && "opacity-50")}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={row.selected}
              aria-keyshortcuts={canMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
              data-account-row={id}
              onClick={() => onPick(row.instance)}
              onKeyDown={(event) => drag.step(event, id)}
              className={cn(
                "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
                row.selected && "bg-control/60",
                grips && "pr-1",
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                {row.rest || (reading && reading.used >= 100) ? <SleepingDog size={19} /> : <InstanceProviderMark instance={row.instance} size={16} />}
              </span>
              <span data-account-name-line className="flex h-[1lh] min-w-0 flex-auto flex-wrap content-start items-center gap-x-2.5 overflow-hidden">
                <span data-account-label title={row.label} className="min-w-0 flex-auto truncate">{row.label}</span>
                {status && <span data-account-status title={status} className="shrink-0 whitespace-nowrap text-[11px] text-ink-secondary">{status}</span>}
                {row.signIn && <span data-account-sign-in className="shrink-0 whitespace-nowrap text-[12px] font-medium text-accent-text">{t("accounts.signIn")}</span>}
              </span>
              <AccountChargeColumns used={reading?.used} rest={row.rest} now={now} />
              <span data-account-check={active ? "on" : "off"} className="flex w-4 shrink-0 items-center justify-center">
                {active && <Check size={14} aria-hidden="true" className="text-accent-text" />}
              </span>
              {grips && (
                <span
                  aria-hidden="true"
                  data-account-grip={canMove || undefined}
                  title={canMove ? t("accounts.dragHint") : undefined}
                  className={cn(
                    "flex w-5 shrink-0 cursor-grab items-center justify-center self-stretch text-ink-secondary",
                    !canMove && "invisible",
                  )}
                >
                  <GripVertical size={13} />
                </span>
              )}
            </button>
          </div>
        );
      })}
      {onSettings && <button type="button" role="menuitem" onClick={onSettings} className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-ink-secondary hover:bg-raised-hover"><span className="flex size-5 shrink-0 items-center justify-center"><Settings size={16} /></span>{t("accounts.title")}</button>}
      {onAdd && (
        <button
          type="button"
          role="menuitem"
          data-account-add
          onClick={onAdd}
          className={cn("flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus", rows.length > 0 && "mt-1")}
        >
          <span className="flex size-5 shrink-0 items-center justify-center"><Plus size={16} aria-hidden="true" /></span>
          {t("accounts.add")}
        </button>
      )}
      </div>
    </div>
  );
}
