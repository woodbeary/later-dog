import { Check, GripVertical, Plus, Settings } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";
import { InstanceProviderMark } from "./ProviderIcons";
import { SleepingDog, type AccountRest } from "./AccountCharge";
import { AccountCharge } from "./AccountBattery";
import { AccountUsageCard } from "./AccountUsageGlance";
import { usageReading, type PlanProvider } from "./PlanUsage";
import { useAccountDrag } from "./account-drag";
import { useHoverCard } from "./hover-card";

export interface AccountMenuRow {
  instance: InstanceInfo;
  label: string;
  selected: boolean;
  movable?: boolean;
  provider?: PlanProvider;
  rest?: AccountRest;
  inUse?: boolean;
}

export function AccountMenu({ rows, onPick, onAdd, onReorder, onSettings, onManageUsage, auto = false, now = Date.now() }: {
  rows: readonly AccountMenuRow[];
  onSettings?: () => void;
  onManageUsage?: () => void;
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
  const hover = useHoverCard();
  const shown = drag.order.flatMap((id) => rows.filter((row) => row.instance.instanceId === id)).filter((row, index, all) =>
    all.findIndex((other) => other.instance.instanceId === row.instance.instanceId) === index);
  const grips = shown.some((row) => drag.movable(row.instance.instanceId));
  const hovered = drag.dragging ? undefined : shown.find((row) => row.instance.instanceId === hover.id);
  return (
    <div ref={hover.rootRef} data-account-menu role="menu" aria-label={t("accounts.title")} className="relative flex min-h-0 flex-col">
      <div ref={hover.listRef} className="flex min-h-0 flex-col overflow-y-auto p-1" {...drag.list}>
      {auto && <p data-account-managed className="px-2.5 py-1.5 text-[11px] text-ink-secondary">{t("accounts.automatic")}</p>}
      {shown.map((row) => {
        const id = row.instance.instanceId;
        const canMove = drag.movable(id);
        const reading = usageReading(row.provider);
        return (
          <div key={id} role="none" {...drag.row(id)} {...hover.row(id)} className={cn("group", drag.dragging === id && "opacity-50")}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={row.selected}
              aria-haspopup={row.rest || reading ? "menu" : undefined}
              aria-expanded={row.rest || reading ? hovered?.instance.instanceId === id : undefined}
              aria-keyshortcuts={canMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
              data-account-row={id}
              onClick={() => onPick(row.instance)}
              onKeyDown={(event) => { drag.step(event, id); hover.key(event, id); }}
              className={cn(
                "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
                (row.selected || hovered?.instance.instanceId === id) && "bg-control/60",
                grips && "pr-1",
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                {row.rest || (reading && reading.used >= 100) ? <SleepingDog size={19} /> : <InstanceProviderMark instance={row.instance} size={16} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.inUse && <span data-account-in-use className="text-[11px] text-accent-text">{t("accounts.inUseNow")}</span>}
              <AccountCharge used={reading?.used} rest={row.rest} now={now} />
              <Check size={14} aria-hidden="true" className={cn("shrink-0 text-ink-secondary", !row.selected && "invisible")} />
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
      {hovered && (hovered.rest || usageReading(hovered.provider)) && (
        <div
          data-account-hover-card
          role="menu"
          aria-label={hovered.label}
          style={{ top: hover.top }}
          onPointerEnter={hover.keep}
          onPointerLeave={hover.leave}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft") return;
            event.preventDefault();
            hover.rootRef.current?.querySelector<HTMLElement>(`[data-account-row="${hovered.instance.instanceId}"]`)?.focus();
          }}
          className="absolute right-full pr-1.5"
        >
          <div className="overflow-hidden rounded-xl border border-hairline/50 bg-card shadow-2xl shadow-black/50">
            <AccountUsageCard
              name={hovered.label}
              plan={hovered.provider?.plan}
              provider={hovered.provider}
              rest={hovered.rest}
              now={now}
              onManage={() => onManageUsage?.()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
