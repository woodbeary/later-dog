import { useEffect, useState } from "react";
import { Check, Loader2, Sparkles } from "lucide-react";
import { pill } from "@/components/AccountsPanel";
import { useCloudTrial, type TrialStatus } from "@/components/CloudTrial";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export const freeAiShown = (status: TrialStatus | null, started = false) =>
  ((status?.state === "offered" || status?.state === "active" || status?.state === "used_up") && status.ai === true)
  || (status?.state === "pending" && started);

export const freeAiReady = (status: TrialStatus | null) => (status?.state === "active" || status?.state === "used_up") && status.ai === true;

export function FreeAiRow({ onReady, onStatus }: { onReady: () => void; onStatus?: (status: TrialStatus | null) => void }) {
  const { status, busy, error, start: startTrial } = useCloudTrial();
  const [started, setStarted] = useState(false);
  const start = () => {
    setStarted(true);
    startTrial();
  };
  const ready = freeAiReady(status);

  useEffect(() => {
    onStatus?.(freeAiShown(status, started) ? status : null);
    if (ready) onReady();
  }, [status, started, ready, onReady, onStatus]);

  if (!freeAiShown(status, started)) return null;
  let slot;
  if (ready) {
    slot = (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-secondary">
        <Check size={14} strokeWidth={2.25} aria-hidden="true" />
        {t("onboarding.engines.ready")}
      </span>
    );
  } else if (status?.state === "pending" || busy) {
    const url = status?.state === "pending" ? status.url : null;
    slot = (
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
  } else {
    slot = (
      <button type="button" onClick={start} className={pill}>
        {t("onboarding.engines.freeAi.try")}
      </button>
    );
  }
  return (
    <li data-onboarding-account="free-ai" className="flex h-14 items-center gap-3 px-4">
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control">
        <Sparkles size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">{t("onboarding.engines.freeAi.name")}</span>
        <span className="block truncate text-[12px] text-ink-secondary" role={error ? "alert" : undefined}>
          {error ?? t("onboarding.engines.freeAi.detail")}
        </span>
      </span>
      <span className="flex min-w-[7.5rem] shrink-0 items-center justify-end">{slot}</span>
    </li>
  );
}
