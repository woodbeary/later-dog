import { useState } from "react";
import type { InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { pill } from "./AccountsPanel";
import { ApiKeyEngineManage, apiKeySection, hasSavedApiKey } from "./EngineSetup";

export function savedKeyEngines(instances: readonly InstanceInfo[]): InstanceInfo[] {
  const keys = new Set<string>();
  return instances.filter((instance) => {
    if (!hasSavedApiKey(instance)) return false;
    const key = apiKeySection(instance) ?? instance.instanceId;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

export function SavedApiKeys({ instances }: { instances: readonly InstanceInfo[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul data-saved-api-keys className="divide-y divide-hairline/40 rounded-xl bg-card">
      {instances.map((instance) => {
        const expanded = open === instance.instanceId;
        return (
          <li key={instance.instanceId} data-saved-api-key={instance.instanceId} className="px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[13px] text-ink">{instance.displayName}</div>
                <div className="text-[12px] text-ink-secondary">{t("model.apiKeyHint")}</div>
              </div>
              <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : instance.instanceId)} className={pill}>
                {expanded ? t("common.close") : t("keys.change")}
              </button>
            </div>
            {expanded && <ApiKeyEngineManage instance={instance} className="mt-3" />}
          </li>
        );
      })}
    </ul>
  );
}
