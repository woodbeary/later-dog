import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronRight, Circle, Cloud, ExternalLink, Loader2, MonitorPlay, Square, X } from "lucide-react";

import { ChatMarkdown } from "./ChatMarkdown";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import {
  cloudTaskActive, cloudTaskPatch, cloudTaskWorking, cloudTaskScreen, cloudTaskStatus, cloudTaskStatusClass, elapsedLabel, filesChangedLabel, plainStep, projectName,
  publishCloudTask, stageLabel, stopCloudTask, useCloudTask, useCloudTaskActivity,
} from "@/lib/cloud-tasks";
import { t } from "@/lib/i18n";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { useStore, type Bot } from "@/state/store";
import { patchFiles, type CloudTaskFileChange, type CloudTaskStep, type CloudTaskTodo } from "../../shared/cloud-task";

const PANEL_WIDTH_KEY = "laterdog-computer-panel-width";

function panelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= 360 && stored <= 960) return stored;
  } catch {
    return 440;
  }
  return 440;
}

function TodoList({ todos, working }: { todos: CloudTaskTodo[]; working: boolean }) {
  return (
    <ul className="space-y-1" aria-label={t("cloudTask.plan")}>
      {todos.map((todo, index) => (
        <li key={index} className="flex items-start gap-2 text-[12.5px] leading-5">
          {todo.status === "completed" ? <Check size={14} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />
            : todo.status === "in_progress" && working ? <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-accent" aria-hidden="true" />
              : <Circle size={12} className="mt-1 shrink-0 text-ink-tertiary" aria-hidden="true" />}
          <span className={cn(todo.status === "completed" ? "text-ink-secondary line-through decoration-ink-tertiary/60" : "text-ink")}>{todo.text}</span>
        </li>
      ))}
    </ul>
  );
}

function StepRow({ step }: { step: CloudTaskStep }) {
  switch (step.k) {
    case "stage":
      return <div className="pt-2 text-[11.5px] font-semibold uppercase tracking-wide text-ink-tertiary">{stageLabel(step.stage)}</div>;
    case "say":
      return <div className="text-[13px] leading-relaxed text-ink"><ChatMarkdown text={step.text} /></div>;
    case "plan":
      return null;
    case "done":
      return (
        <div className="rounded-lg bg-inset px-3 py-2">
          <div className="mb-1 text-[12px] font-semibold text-ink-secondary">{step.ok ? t("cloudTask.step.done") : t("cloudTask.step.stopped")}</div>
          {step.text && <div className="text-[13px] leading-relaxed text-ink"><ChatMarkdown text={step.text} /></div>}
        </div>
      );
    case "tool": case "error": {
      const plain = plainStep(step);
      if (!plain) return null;
      const Mark = step.k === "error" ? AlertTriangle : ChevronRight;
      return (
        <div className="flex min-w-0 items-baseline gap-1.5 text-[12.5px] text-ink-secondary">
          <Mark size={12} className="shrink-0 translate-y-0.5 text-ink-tertiary" aria-hidden="true" />
          <span className="shrink-0">{plain.text}</span>
          {plain.detail && <code className="min-w-0 truncate rounded bg-inset px-1 py-px font-mono text-[11.5px] text-ink">{plain.detail}</code>}
        </div>
      );
    }
  }
}

function FileRow({ file }: { file: CloudTaskFileChange }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] hover:bg-raised"
      >
        {open ? <ChevronDown size={13} className="shrink-0 text-ink-tertiary" aria-hidden="true" /> : <ChevronRight size={13} className="shrink-0 text-ink-tertiary" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{file.path}</span>
        {file.binary ? <span className="shrink-0 text-ink-tertiary">{t("cloudTask.binary")}</span> : (
          <span className="shrink-0 font-mono text-[11.5px] text-ink-tertiary">+{file.additions} −{file.deletions}</span>
        )}
      </button>
      {open && !file.binary && (
        <pre className="mb-2 mt-1 max-h-[360px] overflow-auto rounded-lg bg-inset p-2 font-mono text-[11.5px] leading-[1.45]">
          {file.hunks.split("\n").map((line, index) => (
            <div
              key={index}
              className={cn(
                "whitespace-pre",
                line.startsWith("+") ? "bg-success/10 text-success" : line.startsWith("-") ? "bg-danger/10 text-danger" : line.startsWith("@@") ? "text-accent" : "text-ink-secondary",
              )}
            >
              {line || " "}
            </div>
          ))}
        </pre>
      )}
    </li>
  );
}

function Changes({ jobId, files: fileCount }: { jobId: string; files: number }) {
  const [files, setFiles] = useState<CloudTaskFileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(fileCount <= 8);
  useEffect(() => {
    if (!open || files) return;
    let stopped = false;
    cloudTaskPatch(jobId)
      .then(({ patch }) => { if (!stopped) setFiles(patchFiles(patch)); })
      .catch((failure: unknown) => { if (!stopped) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { stopped = true; };
  }, [jobId, open, files]);
  return (
    <div>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex items-center gap-1 text-[12.5px] font-medium text-ink-secondary hover:text-ink">
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        {filesChangedLabel(fileCount)}
      </button>
      {open && (
        error ? <p className="mt-1 text-[12px] text-danger">{error}</p>
          : !files ? <div className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{t("cloudTask.loadingChanges")}</div>
            : <ul className="mt-1">{files.map((file) => <FileRow key={file.path} file={file} />)}</ul>
      )}
    </div>
  );
}

export function CloudTaskPanel({ jobId, bot }: { jobId: string; bot?: Bot }) {
  const { dispatch } = useStore();
  const { padClass } = useCaptionChrome();
  const [width] = useState(panelWidth);
  const entry = useCloudTask(jobId);
  const summary = entry?.summary;
  const active = cloudTaskActive(summary);
  const working = cloudTaskWorking(summary);
  const activity = useCloudTaskActivity(jobId, working);
  const status = cloudTaskStatus(entry);
  const [pending, setPending] = useState<null | "screen" | "stop" | "publish">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [active]);
  const elapsed = elapsedLabel(summary, now);

  const plan = useMemo(() => {
    for (let index = activity.steps.length - 1; index >= 0; index -= 1) {
      const step = activity.steps[index];
      if (step.k === "plan") return step.todos;
    }
    return null;
  }, [activity.steps]);
  const steps = useMemo(() => {
    const finalWords = new Set(activity.steps.flatMap((step) => (step.k === "done" && step.text ? [step.text.trim()] : [])));
    return activity.steps.filter((step, index, all) => {
      if (step.k === "plan") return false;
      if (step.k === "say" && finalWords.has(step.text.trim())) return false;
      const previous = all[index - 1];
      return !(step.k === "stage" && previous?.k === "stage" && previous.stage === step.stage);
    });
  }, [activity.steps]);

  const feed = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const node = feed.current;
    if (node && working && pinned.current) node.scrollTop = node.scrollHeight;
  }, [steps.length, working]);

  const run = async (kind: "screen" | "stop" | "publish") => {
    setPending(kind);
    setActionError(null);
    try {
      if (kind === "stop") await stopCloudTask(jobId);
      else if (kind === "publish") await publishCloudTask(jobId);
      else {
        const { url } = await cloudTaskScreen(jobId);
        const title = t("cloudTask.screenTitle", { title: summary?.title ?? "" });
        if (window.laterdog?.desktopViewer) {
          const opened = await window.laterdog.desktopViewer.open(url, title, `cloud-task:${jobId}`);
          if (!opened) throw new Error(t("cloudTask.err.screen"));
        } else {
          await openExternalLink(url);
        }
      }
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(null);
    }
  };

  const changes = summary?.changes;
  return (
    <aside
      aria-label={t("cloudTask.panelAria", { title: summary?.title ?? "" })}
      data-testid="cloud-task-panel"
      className={cn(
        "animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel",
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!",
      )}
      style={{ width }}
    >
      <div className={cn("flex items-center justify-between gap-2 px-4 py-3", padClass)}>
        <div className="flex min-w-0 items-center gap-1">
          {bot && (
            <button
              type="button"
              onClick={() => dispatch({ type: "closeCloudTask" })}
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
              aria-label={t("cloudTask.back", { name: bot.name })}
              title={t("cloudTask.back", { name: bot.name })}
            >
              <ArrowLeft size={17} />
            </button>
          )}
          <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-ink">
            <Cloud size={16} className="shrink-0 text-ink-secondary" aria-hidden="true" />
            {t("cloudTask.label")}
            {status.live && <span className="size-1.5 animate-status-pulse rounded-full bg-ink-secondary" role="img" aria-label={t("place.live")} />}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          aria-label={t("cloudTask.close")}
          title={t("cloudTask.close")}
        >
          <X size={18} />
        </button>
      </div>

      <div ref={feed} onScroll={(event) => { const node = event.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }} className="flex-1 overflow-y-auto px-5 pb-6">
        <h3 className="text-[16px] font-semibold leading-snug text-ink">{summary?.title ?? "…"}</h3>
        {summary && <div className="mt-0.5 truncate text-[12.5px] text-ink-tertiary">{projectName(summary.repository)}</div>}
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-secondary">
          <span aria-live="polite" className={cn("shrink-0 font-medium", cloudTaskStatusClass(status))}>{status.label}</span>
          {[status.note, elapsed].filter(Boolean).map((part) => <span key={part} className="min-w-0 truncate">· {part}</span>)}
        </div>
        {status.detail && (
          <p className="mt-2 rounded-lg bg-inset px-3 py-2 text-[12.5px] leading-5 text-ink-secondary">{status.detail}</p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {summary?.screen && (
            <button type="button" disabled={pending !== null} onClick={() => void run("screen")} className="inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-control-hover disabled:opacity-60">
              {pending === "screen" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <MonitorPlay size={13} aria-hidden="true" />}
              {t("cloudTask.watchScreen")}
            </button>
          )}
          {summary?.prUrl && (
            <button type="button" onClick={() => void openExternalLink(summary.prUrl!)} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium hover:brightness-110">
              {t("cloudTask.reviewChanges")}
              <ExternalLink size={12} aria-hidden="true" />
            </button>
          )}
          {summary?.publishable && (
            <button type="button" disabled={pending !== null} onClick={() => void run("publish")} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium hover:brightness-110 disabled:opacity-60">
              {pending === "publish" && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              {t("cloudTask.publish")}
            </button>
          )}
          {summary?.stoppable && (
            <button type="button" disabled={pending !== null} onClick={() => void run("stop")} className="inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-control-hover disabled:opacity-60">
              {pending === "stop" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Square size={12} aria-hidden="true" />}
              {t("cloudTask.stop")}
            </button>
          )}
        </div>
        {summary?.publishable && <p className="mt-2 text-[12px] leading-5 text-ink-tertiary">{t("cloudTask.publishHint")}</p>}
        {actionError && <p role="alert" className="mt-2 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">{actionError}</p>}

        {changes && changes.files > 0 && (
          <section className="mt-5">
            <h4 className="mb-1.5 text-[12px] font-semibold text-ink-secondary">
              {t("cloudTask.changesTitle")} <span className="font-mono font-normal text-ink-tertiary">+{changes.additions} −{changes.deletions}</span>
            </h4>
            <Changes jobId={jobId} files={changes.files} />
          </section>
        )}

        {plan && (
          <section className="mt-5">
            <h4 className="mb-1.5 text-[12px] font-semibold text-ink-secondary">{t("cloudTask.plan")}</h4>
            <TodoList todos={plan} working={working} />
          </section>
        )}

        <section className="mt-5">
          <h4 className="mb-1.5 text-[12px] font-semibold text-ink-secondary">{t("cloudTask.steps")}</h4>
          <div className="space-y-2" aria-live="polite" aria-relevant="additions">
            {steps.map((step, index) => <StepRow key={`${step.t}:${index}`} step={step} />)}
          </div>
          {activity.loading && !steps.length && (
            <div className="flex items-center gap-1.5 text-[12.5px] text-ink-secondary"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{t("cloudTask.loadingSteps")}</div>
          )}
          {!activity.loading && !steps.length && (
            <p className="text-[12.5px] text-ink-secondary">{activity.reason ?? activity.error ?? (activity.live ? t("cloudTask.noStepsYet") : t("cloudTask.noSteps"))}</p>
          )}
          {steps.length > 0 && activity.live && working && (
            <div className="mt-3 flex items-center gap-1.5 text-[12px] text-ink-tertiary"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{t("cloudTask.stillWorking")}</div>
          )}
          {activity.error && steps.length > 0 && <p className="mt-2 text-[12px] text-ink-secondary">{activity.error}</p>}
        </section>
      </div>
    </aside>
  );
}
