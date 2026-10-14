import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, CircleStop, Cloud, Hand, Info } from "lucide-react";

import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import {
  cloudTaskStatus, cloudTaskStatusClass, cloudTaskWorking, cloudWakeupOf, elapsedLabel, plainSteps, projectName, runsWithLabel, stopCloudTask,
  useCloudTask, useCloudTaskActivity, useTraceSave, wakeupLine, type CloudTaskStatusView,
} from "@/lib/cloud-tasks";
import { t } from "@/lib/i18n";
import { useStore, type Message } from "@/state/store";
import type { CloudTaskSummary } from "../../shared/cloud-task";

function useMinuteClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

export const CloudTaskUpdateRow = memo(function CloudTaskUpdateRow({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const wakeup = cloudWakeupOf(message);
  const entry = useCloudTask(wakeup?.jobId);
  if (!wakeup) return null;
  const title = entry?.summary?.title;
  return (
    <div className="flex justify-center" data-testid="cloud-task-update">
      <button
        type="button"
        onClick={() => dispatch({ type: "openCloudTask", jobId: wakeup.jobId })}
        className="flex max-w-full min-w-0 items-center gap-1.5 rounded-full px-3 py-1 text-[12px] text-ink-tertiary hover:bg-raised hover:text-ink-secondary"
      >
        <Cloud size={12} aria-hidden="true" className="shrink-0" />
        <span className="shrink-0">{wakeupLine(wakeup.event)}</span>
        {title && <span aria-hidden="true" className="shrink-0">·</span>}
        {title && <span className="min-w-0 truncate">{title}</span>}
      </button>
    </div>
  );
});

function StatusGlyph({ view }: { view: CloudTaskStatusView }) {
  switch (view.phase) {
    case "review": case "done": return <Check size={12} aria-hidden="true" className="shrink-0" />;
    case "stopped": return <CircleStop size={12} aria-hidden="true" className="shrink-0" />;
    case "attention": return <Hand size={12} aria-hidden="true" className="shrink-0 text-ink" />;
    default: return null;
  }
}

function ProgressLine({ view }: { view: CloudTaskStatusView }) {
  return (
    <div aria-hidden="true" data-cloud-task-progress className="h-0.5 w-full bg-ink/[0.07]">
      <div
        className={cn("h-full transition-[width] duration-500 ease-out", view.live ? "bg-ink/45" : "bg-ink/15")}
        style={{ width: `${Math.round(Math.min(1, Math.max(0, view.progress)) * 100)}%` }}
      />
    </div>
  );
}

const STEP_ROWS = 6;

function CloudTaskSteps({ jobId, title, summary, view, panelLink }: {
  jobId: string;
  title: string;
  summary: CloudTaskSummary | undefined;
  view: CloudTaskStatusView;
  panelLink?: () => void;
}) {
  const activity = useCloudTaskActivity(jobId, cloudTaskWorking(summary));
  const steps = useMemo(() => plainSteps(activity.steps), [activity.steps]);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const node = list.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [steps.length]);

  const stop = async () => {
    setStopping(true);
    setStopFailed(false);
    try { await stopCloudTask(jobId); } catch { setStopFailed(true); } finally { setStopping(false); }
  };
  const empty = activity.loading ? t("cloudTask.loadingSteps")
    : activity.reason ?? activity.error ?? (view.live ? t("cloudTask.noStepsYet") : t("cloudTask.noSteps"));
  const stoppable = Boolean(summary?.stoppable);
  const trace = summary?.trace;
  const traceSave = useTraceSave(jobId);

  return (
    <div className="border-t border-hairline/30 px-3.5 pb-3 pt-2.5" data-cloud-task-steps>
      {view.detail && (
        <p className="mb-2 flex items-start gap-1.5 text-[12.5px] leading-5 text-ink-secondary">
          <Info size={13} aria-hidden="true" className="mt-[3px] shrink-0" />
          <span className="line-clamp-3 min-w-0 break-words">{view.detail}</span>
        </p>
      )}
      <ol
        ref={list}
        aria-label={t("cloudTask.steps")}
        onScroll={(event) => {
          const node = event.currentTarget;
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        }}
        className="overflow-y-auto rounded-xl bg-inset px-3 py-1.5"
        style={{ height: STEP_ROWS * 20 + 12 }}
      >
        {steps.length === 0 ? (
          <li className="flex h-5 items-center text-[12.5px] text-ink-tertiary">{empty}</li>
        ) : steps.map((step, index) => (
          <li key={index} className="flex h-5 min-w-0 items-baseline gap-1.5 text-[12.5px] leading-5">
            <span className={cn("text-ink", step.detail ? "shrink-0" : "min-w-0 truncate")}>{step.text}</span>
            {step.detail && <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-tertiary">{step.detail}</span>}
          </li>
        ))}
      </ol>
      {(panelLink || stoppable || stopFailed || trace || traceSave.error) && (
        <div className="mt-2 flex min-h-7 items-center gap-1">
          {panelLink && (
            <button
              type="button"
              onClick={panelLink}
              aria-label={t("cloudTask.openAria", { title })}
              className="rounded-md px-2 py-1 text-[12.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
            >
              {t("cloudTask.open")}
            </button>
          )}
          {stoppable && (
            <button
              type="button"
              onClick={() => void stop()}
              disabled={stopping}
              aria-label={t("cloudTask.stopAria", { title })}
              className="rounded-md px-2 py-1 text-[12.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
            >
              {stopping ? t("cloudTask.stopping") : t("cloudTask.stop")}
            </button>
          )}
          {trace && (
            <button
              type="button"
              onClick={() => { void traceSave.save(); }}
              disabled={traceSave.saving}
              aria-label={t("cloudTask.traceAria", { title })}
              className="rounded-md px-2 py-1 text-[12.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
            >
              {t("cloudTask.trace")}
            </button>
          )}
          {stopFailed && <span role="alert" className="text-[12px] text-ink-secondary">{t("cloudTask.err.stop")}</span>}
          {traceSave.error && <span role="alert" className="text-[12px] text-ink-secondary">{traceSave.error}</span>}
        </div>
      )}
    </div>
  );
}

export const CloudTaskCard = memo(function CloudTaskCard({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const ref = message.cloudTask;
  const entry = useCloudTask(ref?.jobId);
  const summary = entry?.summary;
  const view = cloudTaskStatus(entry);
  const now = useMinuteClock(view.live);
  const [open, setOpen] = useState(false);
  if (!ref) return null;
  const title = summary?.title ?? ref.title;
  const project = projectName(summary?.repository ?? ref.repository);
  const elapsed = view.phase === "working" ? elapsedLabel(summary, now) : null;
  const line = [view.note, elapsed].filter(Boolean).join(" · ");
  const runsWith = runsWithLabel(summary);
  const openTask = () => dispatch({ type: "openCloudTask", jobId: ref.jobId });
  const prUrl = view.phase === "review" ? summary?.prUrl : undefined;
  const primary = view.phase === "review"
    ? { label: t("cloudTask.reviewChanges"), name: t("cloudTask.reviewAria", { title }), run: prUrl ? () => void openExternalLink(prUrl) : openTask }
    : { label: t("cloudTask.open"), name: t("cloudTask.openAria", { title }), run: openTask };

  return (
    <div className="flex justify-start">
      <section
        aria-label={t("cloudTask.cardAria", { title, status: view.label })}
        data-testid="cloud-task-card"
        data-phase={view.phase}
        className="@container/cloudtask w-full max-w-[min(42rem,max(78%,18rem))] overflow-hidden rounded-card bg-card ring-[0.5px] ring-ink/10"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 pl-3.5 pr-3">
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-inset text-ink-secondary @max-[22rem]/cloudtask:hidden">
            <Cloud size={15} />
          </span>
          <div className="min-w-[9rem] flex-1">
            <p className="truncate text-[14px] font-medium leading-5 text-ink" title={title}>
              {view.phase === "working" && <span className="font-normal text-ink-secondary">{t("cloudTask.workingOn")} </span>}
              {title}
            </p>
            <p data-cloud-task-status className="flex h-[18px] min-w-0 items-center gap-1 text-[12.5px] leading-[18px] text-ink-secondary">
              <StatusGlyph view={view} />
              <span aria-live="polite" className={cn("shrink-0", cloudTaskStatusClass(view))}>{view.label}</span>
              {line && <span className="min-w-0 truncate">· {line}</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={primary.run}
            aria-label={primary.name}
            className="h-7 shrink-0 rounded-full bg-accent px-3 text-[13px] font-medium transition-[filter] hover:brightness-110"
          >
            {primary.label}
          </button>
        </div>
        <ProgressLine view={view} />
        <div className="flex h-8 items-center gap-2 px-3.5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={t("cloudTask.stepsAria", { title })}
            onClick={() => setOpen((value) => !value)}
            className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-[12px] text-ink-secondary hover:text-ink"
          >
            <ChevronRight size={13} aria-hidden="true" className={cn("shrink-0 transition-transform", open && "rotate-90")} />
            {t("cloudTask.steps")}
          </button>
          {(runsWith || project) && (
            <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[12px] text-ink-tertiary">
              {runsWith && <span data-cloud-task-runs-with className="shrink-0" title={t("cloudTask.runsWith")}>{runsWith}</span>}
              {runsWith && project && <span aria-hidden="true">·</span>}
              {project && <span className="min-w-0 truncate">{project}</span>}
            </span>
          )}
        </div>
        {open && <CloudTaskSteps jobId={ref.jobId} title={title} summary={summary} view={view} panelLink={prUrl ? openTask : undefined} />}
      </section>
    </div>
  );
});
