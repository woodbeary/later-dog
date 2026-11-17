import { useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { activeLocale, t } from "@/lib/i18n";
import { dismissUsageNotice, resetClock, usageNoticeDismissed, usageNoticeFor } from "@/lib/usage-notice";
import { usePlanUsage, type PlanProvider } from "./PlanUsage";

export function usageNoticeWords(provider: PlanProvider | undefined): string | null {
  const notice = usageNoticeFor(provider);
  if (!notice) return null;
  if (notice.window === "fiveHour" && notice.resetsAt) {
    const time = resetClock(notice.resetsAt, activeLocale());
    return notice.level === "almost" ? t("composer.usage.fiveHourAlmost", { time }) : t("composer.usage.fiveHourMost", { time });
  }
  return notice.level === "almost" ? t("composer.usage.weeklyAlmost") : t("composer.usage.weeklyMost");
}

export interface UsageNoticeProps {
  provider: PlanProvider | undefined;
  onOpen(): void;
}

export function UsageNotice({ provider, onOpen }: UsageNoticeProps) {
  const notice = usageNoticeFor(provider);
  const [hidden, setHidden] = useState<string | null>(null);
  const words = usageNoticeWords(provider);
  if (!notice || !words || hidden === notice.key || usageNoticeDismissed(notice.key)) return null;
  return (
    <div data-usage-notice className="composer-usage-row">
      <button type="button" data-usage-notice-open onClick={onOpen} className="composer-usage-open">
        <span className="truncate">{words}</span>
        <ChevronRight size={12} aria-hidden="true" className="composer-usage-chevron" />
      </button>
      <button
        type="button"
        data-usage-notice-hide
        aria-label={t("composer.usage.hide")}
        onClick={() => {
          dismissUsageNotice(notice.key);
          setHidden(notice.key);
        }}
        className="composer-usage-hide"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ComposerUsageNotice({ instanceId, onOpen }: { instanceId: string | undefined; onOpen(): void }) {
  const usage = usePlanUsage({ enabled: false });
  const provider = instanceId ? usage.report?.providers.find((entry) => entry.id === instanceId) : undefined;
  return <UsageNotice provider={provider} onOpen={onOpen} />;
}
