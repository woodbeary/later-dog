import { Check, GripVertical, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";
import { InstanceProviderMark } from "./ProviderIcons";
import { useAccountDrag } from "./account-drag";

export interface AccountMenuRow {
  instance: InstanceInfo;
  label: string;
  selected: boolean;
  movable?: boolean;
}

export function AccountMenu({ rows, onPick, onAdd, onReorder }: {
  rows: readonly AccountMenuRow[];
  onPick: (instance: InstanceInfo) => void;
  onAdd?: () => void;
  onReorder?: (ids: string[]) => void;
}) {
  const drag = useAccountDrag(
    rows.map((row) => ({ id: row.instance.instanceId, kind: row.instance.driverKind, movable: Boolean(onReorder && row.movable) })),
    (ids) => onReorder?.(ids),
  );
  const shown = drag.order.flatMap((id) => rows.filter((row) => row.instance.instanceId === id));
  const grips = shown.some((row) => drag.movable(row.instance.instanceId));
  return (
    <div data-account-menu role="menu" aria-label={t("accounts.title")} className="flex min-h-0 flex-col overflow-y-auto p-1" {...drag.list}>
      {shown.map((row) => {
        const id = row.instance.instanceId;
        const canMove = drag.movable(id);
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
              <InstanceProviderMark instance={row.instance} size={16} />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              {row.selected && <Check size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
              {grips && (
                <span
                  aria-hidden="true"
                  data-account-grip={canMove || undefined}
                  title={canMove ? t("accounts.dragHint") : undefined}
                  className={cn(
                    "flex w-5 shrink-0 cursor-grab items-center justify-center self-stretch text-ink-tertiary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
                    !canMove && "invisible",
                  )}
                >
                  <GripVertical size={12} />
                </span>
              )}
            </button>
          </div>
        );
      })}
      {onAdd && (
        <button
          type="button"
          role="menuitem"
          data-account-add
          onClick={onAdd}
          className={cn("flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus", rows.length > 0 && "mt-1")}
        >
          <Plus size={16} aria-hidden="true" className="shrink-0" />
          {t("accounts.add")}
        </button>
      )}
    </div>
  );
}
