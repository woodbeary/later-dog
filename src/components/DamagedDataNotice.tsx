import { useState } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import type { DamagedData } from "../../shared/damaged-data";

export function damagedDataLine(damaged: DamagedData[]): string {
  return damaged
    .map(({ name, keptAs }) => [t(`damagedData.${name}`), ...(keptAs ? [t("damagedData.kept", { file: keptAs })] : [])].join(" "))
    .join(" ");
}

export function DamagedDataNotice() {
  const { state } = useStore();
  const [dismissed, setDismissed] = useState(false);
  const damaged = state.config?.damagedData ?? [];
  if (dismissed || damaged.length === 0) return null;
  return (
    <div
      role="status"
      className="animate-panel-in rounded-xl border border-hairline/40 bg-panel p-3.5 shadow-2xl shadow-black/50"
      data-testid="damaged-data-notice"
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1 break-words text-[12.5px] text-ink-secondary">{damagedDataLine(damaged)}</div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
