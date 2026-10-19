import { useEffect, useState } from "react";
import { Check, Loader2, Sparkles } from "lucide-react";
import { useStore, type InstanceInfo } from "@/state/store";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isIncludedEngine } from "../../shared/account-engines";
import { pill } from "./AccountsPanel";
import { useCloudTrial, type TrialStatus } from "./CloudTrial";

export type IncludedAi = { ready: true } | { ready: false; reason: string | null };

export const freeAiShown = (status: TrialStatus | null, started = false) =>
  ((status?.state === "offered" || status?.state === "active" || status?.state === "used_up") && status.ai === true)
  || (status?.state === "pending" && started);

export const freeAiReady = (status: TrialStatus | null) => (status?.state === "active" || status?.state === "used_up") && status.ai === true;

export function includedAi(instances: readonly InstanceInfo[]): IncludedAi | null {
  const included = instances.filter((instance) => isIncludedEngine(instance.driverKind));
  if (included.length === 0) return null;
  if (included.some((instance) => instance.snapshot.state === "available" && instance.snapshot.authenticated !== false)) return { ready: true };
  const reason = included.map((instance) => instance.snapshot.authenticationUnavailableReason ?? instance.snapshot.reason).find(Boolean);
  return { ready: false, reason: reason ?? null };
}

export function FreeAiAction({ status, busy, start, primary = false }: { status: TrialStatus | null; busy: boolean; start: () => void; primary?: boolean }) {
  if (freeAiReady(status)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-secondary">
        <Check size={14} strokeWidth={2.25} aria-hidden="true" />
        {t("onboarding.engines.ready")}
      </span>
    );
  }
  if (status?.state === "pending" || busy) {
    const url = status?.state === "pending" ? status.url : null;
    return (
      <button
        type="button"
        aria-disabled={!url}
        onClick={() => {
          if (url) void openExternalLink(url).catch(() => {});
        }}
        title={url ? t("onboarding.engines.openAgain") : undefined}
        className={cn(pill, "inline-flex items-center gap-1.5", !url && "pointer-events-none")}
      >
        <Loader2 size={13} aria-hidden="true" className="animate-spin" />
        {t("onboarding.engines.freeAi.checking")}
      </button>
    );
  }
  return (
    <button type="button" onClick={start} className={cn(pill, primary && "bg-accent font-medium text-white hover:bg-accent hover:brightness-110")}>
      {t("onboarding.engines.freeAi.try")}
    </button>
  );
}

function TryFree({ primary }: { primary: boolean }) {
  const { refreshInstances } = useStore();
  const { status, busy, start: startTrial } = useCloudTrial();
  const [started, setStarted] = useState(false);
  const ready = freeAiReady(status);
  useEffect(() => {
    if (ready) void refreshInstances();
  }, [ready, refreshInstances]);
  if (!freeAiShown(status, started)) return null;
  return <FreeAiAction status={status} busy={busy} primary={primary} start={() => { setStarted(true); startTrial(); }} />;
}

export function IncludedAiAccount({ instances, className, primary = false }: { instances: readonly InstanceInfo[]; className?: string; primary?: boolean }) {
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
      {included.ready ? <span className="shrink-0 text-[12px] text-ink-secondary">{t("accounts.included.badge")}</span> : <TryFree primary={primary} />}
    </div>
  );
}
