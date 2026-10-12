import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";
import { InstanceProviderMark } from "./ProviderIcons";

export interface AccountMenuRow {
  instance: InstanceInfo;
  label: string;
  selected: boolean;
}

export function AccountMenu({ rows, onPick, onAdd }: { rows: readonly AccountMenuRow[]; onPick: (instance: InstanceInfo) => void; onAdd?: () => void }) {
  return (
    <div data-account-menu role="menu" aria-label={t("accounts.title")} className="flex min-h-0 flex-col overflow-y-auto p-1">
      {rows.map((row) => (
        <button
          key={row.instance.instanceId}
          type="button"
          role="menuitemradio"
          aria-checked={row.selected}
          data-account-row={row.instance.instanceId}
          onClick={() => onPick(row.instance)}
          className={cn(
            "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
            row.selected && "bg-control/60",
          )}
        >
          <InstanceProviderMark instance={row.instance} size={16} />
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          {row.selected && <Check size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
        </button>
      ))}
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
