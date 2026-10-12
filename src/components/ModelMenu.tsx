import { Check, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

export interface ModelMenuGroup {
  instance: InstanceInfo;
  label: string;
  models: ReadonlyArray<{ id: string; label: string }>;
}

export interface ModelMenuEntry {
  instance: InstanceInfo;
  id: string;
  label: string;
}

const PRIMARY = 4;

export function splitModels(groups: readonly ModelMenuGroup[], currentInstanceId: string, currentModel: string): { primary: ModelMenuEntry[]; more: ModelMenuEntry[] } {
  const all = groups.flatMap((group) => group.models.map((model) => ({ instance: group.instance, id: model.id, label: model.label })));
  const key = (entry: ModelMenuEntry) => `${entry.instance.instanceId}\u0000${entry.id}`;
  const picked = new Set<string>();
  const primary: ModelMenuEntry[] = [];
  const take = (entry: ModelMenuEntry | undefined) => {
    if (!entry || picked.has(key(entry)) || primary.length >= PRIMARY) return;
    picked.add(key(entry));
    primary.push(entry);
  };
  const current = all.find((entry) => entry.instance.instanceId === currentInstanceId && entry.id === currentModel);
  take(current);
  for (const group of groups) {
    const own = all.filter((entry) => entry.instance.instanceId === group.instance.instanceId);
    take(own.find((entry) => entry.id === group.instance.models.default) ?? own[0]);
  }
  for (const entry of all) take(entry);
  const order = new Map(all.map((entry, index) => [key(entry), index]));
  primary.sort((a, b) => order.get(key(a))! - order.get(key(b))!);
  return { primary, more: all.filter((entry) => !picked.has(key(entry))) };
}

export function ModelMenu({ groups, currentInstanceId, currentModel, onPick }: {
  groups: readonly ModelMenuGroup[];
  currentInstanceId: string;
  currentModel: string;
  onPick: (instance: InstanceInfo, model: string) => void;
}) {
  const { primary, more } = splitModels(groups, currentInstanceId, currentModel);
  const [moreOpen, setMoreOpen] = useState(false);
  const isCurrent = (entry: ModelMenuEntry) => entry.instance.instanceId === currentInstanceId && entry.id === currentModel;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const index = Number(event.key) - 1;
      const entry = Number.isInteger(index) ? primary[index] : undefined;
      if (!entry) return;
      event.preventDefault();
      onPick(entry.instance, entry.id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [primary, onPick]);

  const row = "flex h-8 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[13.5px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus";
  return (
    <div data-model-menu className="relative">
      <div role="menu" aria-label={t("model.simple.model")} className="flex flex-col p-1">
        {primary.map((entry, index) => (
          <button
            key={`${entry.instance.instanceId}:${entry.id}`}
            type="button"
            role="menuitemradio"
            aria-checked={isCurrent(entry)}
            data-model-option={`${entry.instance.instanceId}:${entry.id}`}
            onClick={() => onPick(entry.instance, entry.id)}
            className={row}
          >
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {isCurrent(entry)
              ? <Check size={14} aria-hidden="true" className="shrink-0 text-accent-text" />
              : <span aria-hidden="true" className="shrink-0 text-[12px] tabular-nums text-ink-tertiary">{index + 1}</span>}
          </button>
        ))}
        {more.length > 0 && (
          <>
            <div className="mx-2.5 my-1 border-t border-hairline/40" />
            <button
              type="button"
              data-model-more
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(true)}
              onMouseEnter={() => setMoreOpen(true)}
              className={cn(row, moreOpen && "bg-raised-hover")}
            >
              <span className="min-w-0 flex-1 truncate">{t("model.more")}</span>
              <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
            </button>
          </>
        )}
      </div>
      {moreOpen && more.length > 0 && (
        <div
          role="menu"
          data-model-more-list
          aria-label={t("model.more")}
          className="absolute bottom-0 right-full mr-1.5 flex max-h-[min(420px,70dvh)] w-56 flex-col overflow-y-auto rounded-xl border border-hairline/50 bg-card p-1 shadow-2xl shadow-black/50"
        >
          {more.map((entry) => (
            <button
              key={`${entry.instance.instanceId}:${entry.id}`}
              type="button"
              role="menuitemradio"
              aria-checked={isCurrent(entry)}
              data-model-option={`${entry.instance.instanceId}:${entry.id}`}
              onClick={() => onPick(entry.instance, entry.id)}
              className={row}
            >
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {isCurrent(entry) && <Check size={14} aria-hidden="true" className="shrink-0 text-accent-text" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
