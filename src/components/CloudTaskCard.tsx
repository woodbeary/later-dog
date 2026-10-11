import { memo, useEffect, useState } from "react";
import { ChevronRight, Cloud, ExternalLink, Loader2 } from "lucide-react";

import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { changesLabel, cloudTaskActive, cloudTaskStatus, elapsedLabel, stepHeadline, TONE_CLASS, useCloudTask } from "@/lib/cloud-tasks";
import { t } from "@/lib/i18n";
import { useStore, type Message } from "@/state/store";

function useMinuteClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

export const CloudTaskCard = memo(function CloudTaskCard({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const ref = message.cloudTask;
  const entry = useCloudTask(ref?.jobId);
  const summary = entry?.summary;
  const running = cloudTaskActive(summary);
  const now = useMinuteClock(running);
  if (!ref) return null;
  const status = cloudTaskStatus(entry);
  const title = summary?.title ?? ref.title;
  const elapsed = elapsedLabel(summary, now);
  const progress = running && summary?.lastStep ? stepHeadline(summary.lastStep) : "";
  const changes = summary?.changes && summary.changes.files > 0
    ? changesLabel(summary.changes)
    : "";
  const repository = summary?.repository ?? ref.repository ?? "";
  const subline = progress || status.detail || [repository, changes].filter(Boolean).join(" · ");
  const open = () => dispatch({ type: "openCloudTask", jobId: ref.jobId });

  return (
    <div className="flex justify-start">
      <section
        aria-label={t("cloudTask.cardAria", { title, status: status.label })}
        data-testid="cloud-task-card"
        className="w-full max-w-[560px] overflow-hidden rounded-xl border border-hairline/45 bg-card"
      >
        <button
          type="button"
          onClick={open}
          title={t("cloudTask.viewProgress")}
          className="group block w-full px-4 pb-2 pt-3 text-left transition-colors hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <div className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
            <Cloud size={13} aria-hidden="true" className="shrink-0" />
            <span className="font-medium">{t("cloudTask.label")}</span>
            <span aria-hidden="true">·</span>
            <span aria-live="polite" className={cn("inline-flex items-center gap-1 font-semibold", TONE_CLASS[status.tone])}>
              {status.live && <Loader2 aria-hidden="true" className="size-3 animate-spin" />}
              {status.label}
            </span>
            {elapsed && <span className="text-ink-tertiary">· {elapsed}</span>}
            <ChevronRight size={14} aria-hidden="true" className="ml-auto shrink-0 text-ink-tertiary transition-transform group-hover:translate-x-0.5" />
          </div>
          <div className="mt-1 line-clamp-2 text-[14px] font-semibold leading-snug text-ink">{title}</div>
          {subline && <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{subline}</div>}
        </button>
        {summary?.prUrl && (
          <div className="flex items-center gap-3 border-t border-hairline/35 px-4 py-2">
            <button
              type="button"
              onClick={() => void openExternalLink(summary.prUrl!)}
              className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline"
            >
              {summary.prNumber ? t("cloudTask.viewPrNumber", { number: summary.prNumber }) : t("cloudTask.viewPr")}
              <ExternalLink size={12} aria-hidden="true" />
            </button>
            {changes && <span className="text-[12px] text-ink-secondary">{changes}</span>}
          </div>
        )}
      </section>
    </div>
  );
});
