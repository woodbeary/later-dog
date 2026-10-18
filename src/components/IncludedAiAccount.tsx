import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useStore, type InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isIncludedEngine } from "../../shared/account-engines";
import { useCloudTrial } from "./CloudTrial";
import { FreeAiAction, freeAiReady, freeAiShown } from "./onboarding/beats/FreeAiRow";

export type IncludedAi = { ready: true } | { ready: false; reason: string | null };

export function includedAi(instances: readonly InstanceInfo[]): IncludedAi | null {
  const included = instances.filter((instance) => isIncludedEngine(instance.driverKind));
  if (included.length === 0) return null;
  if (included.some((instance) => instance.snapshot.state === "available" && instance.snapshot.authenticated !== false)) return { ready: true };
  const reason = included.map((instance) => instance.snapshot.authenticationUnavailableReason ?? instance.snapshot.reason).find(Boolean);
  return { ready: false, reason: reason ?? null };
}

function TryFree() {
  const { refreshInstances } = useStore();
  const { status, busy, start: startTrial } = useCloudTrial();
  const [started, setStarted] = useState(false);
  const ready = freeAiReady(status);
  useEffect(() => {
    if (ready) void refreshInstances();
  }, [ready, refreshInstances]);
  if (!freeAiShown(status, started)) return null;
  return <FreeAiAction status={status} busy={busy} start={() => { setStarted(true); startTrial(); }} />;
}

export function IncludedAiAccount({ instances, className }: { instances: readonly InstanceInfo[]; className?: string }) {
  const included = includedAi(instances);
  if (!included) return null;
  return (
    <div data-included-ai={included.ready ? "ready" : "off"} className={cn("flex min-h-16 items-center gap-3 px-4 py-3", className)}>
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink">
        <Sparkles size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium leading-5 text-ink">{t("onboarding.engines.freeAi.name")}</p>
        <p className="text-[12px] leading-4 text-ink-secondary">
          {included.ready ? t("accounts.included.allowance") : included.reason ?? t("accounts.included.off")}
        </p>
      </div>
      {included.ready ? <span className="shrink-0 text-[12px] text-ink-secondary">{t("accounts.included.badge")}</span> : <TryFree />}
    </div>
  );
}
