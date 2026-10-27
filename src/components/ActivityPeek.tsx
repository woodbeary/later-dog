import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, CircleDot, Loader2, Minus, TriangleAlert, X } from "lucide-react";
import type { Helper, HelperMember, HelperState } from "../../shared/helpers";
import type { TurnReasoning } from "@/lib/turn-reasoning";
import type { TurnStep } from "@/lib/turn-details";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { WorkingTimer } from "./WorkingIndicator";
import { helperStateText } from "./Puppies";
import { formatElapsed } from "@/lib/working-time";

function HelperStateIcon({ state }: { state: HelperState }) {
  const Icon = state === "running" ? Loader2 : state === "done" ? Check : state === "failed" ? TriangleAlert : Minus;
  return <Icon size={14} strokeWidth={1.75} aria-hidden="true" className={cn(
    "shrink-0",
    state === "running" && "animate-spin text-ink-secondary motion-reduce:animate-none",
    state === "done" && "text-ink-tertiary",
    state === "failed" && "text-warning",
    state === "stopped" && "text-ink-tertiary",
  )} />;
}

function HelperDetails({ helper }: { helper: Helper | HelperMember }) {
  return <div className="grid min-w-0 grid-cols-[16px_minmax(0,1fr)] gap-x-2.5">
    <span className="relative z-1 flex h-5 items-center justify-center bg-panel"><HelperStateIcon state={helper.state} /></span>
    <div className="min-w-0 space-y-1">
      <div className="flex items-start justify-between gap-3"><span className="break-words text-[12px] font-medium leading-5 text-ink">{helper.label}</span><span className="shrink-0 pt-0.5 text-[10.5px] text-ink-tertiary">{helperStateText(helper.state)}</span></div>
      {"phase" in helper && helper.phase && <p className="text-[11px] text-ink-tertiary">{helper.phase}</p>}
      {helper.activity && <p className="break-words text-[12px] leading-relaxed text-ink-secondary">{helper.activity}</p>}
      {helper.recentActivity && helper.recentActivity.length > 1 && (
        <ul className="space-y-0.5">
          {helper.recentActivity.slice(0, -1).reverse().map((line, index) => (
            <li key={index} className="break-words text-[11px] leading-relaxed text-ink-tertiary">{line}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-x-3 text-[10.5px] leading-4 tabular-nums text-ink-tertiary">
        {helper.toolUses !== undefined && <span>{t("chat.helpers.tools", { count: helper.toolUses })}</span>}
        {helper.tokens !== undefined && <span>{t("chat.helpers.tokens", { count: helper.tokens.toLocaleString() })}</span>}
        {helper.durationMs !== undefined && <span>{formatElapsed(helper.durationMs)}</span>}
      </div>
    </div>
  </div>;
}

function StepIcon({ state }: { state: TurnStep["state"] }) {
  if (state === "running") return <Loader2 size={14} strokeWidth={1.75} className="shrink-0 animate-spin text-ink-secondary motion-reduce:animate-none" aria-label={t("chat.row.stepRunning")} />;
  if (state === "failed") return <TriangleAlert size={14} strokeWidth={1.75} className="shrink-0 text-warning" aria-label={t("chat.row.stepFailed")} />;
  return <Check size={14} strokeWidth={1.75} className="shrink-0 text-ink-tertiary" aria-label={t("chat.row.stepDone")} />;
}

function ProgressDisclosure({ id, label, open, onToggle, children }: {
  id: string; label: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return <div className="border-t border-hairline/60 pt-2">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} className="-mx-1 flex w-[calc(100%+8px)] items-center gap-2 rounded-lg px-1 py-1.5 text-start text-[11.5px] font-medium text-ink-secondary transition-colors hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2">
      <ChevronRight size={13} aria-hidden="true" className={cn("shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
      <span>{label}</span>
    </button>
    <div id={id} hidden={!open} className="mt-1 ms-1.5 border-s border-hairline/60 py-0.5 ps-3.5">
      {children}
    </div>
  </div>;
}

export interface StepGroup { id: string; label: string; state: TurnStep["state"]; count: number }

export function groupSteps(steps: readonly TurnStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last.label === step.label && last.state === step.state && step.state !== "running") last.count += 1;
    else groups.push({ id: step.id, label: step.label, state: step.state, count: 1 });
  }
  return groups;
}

const connectedStepClass = "relative pb-1.5 before:absolute before:top-4.5 before:bottom-0 before:start-2 before:border-s before:border-hairline/60 last:pb-0 last:before:hidden";

export function ActivityPeek({ label, since, helpers, reasoning, steps = [], updates = [], anchor, onClose }: {
  label: string; since: number | null; helpers: readonly Helper[]; reasoning: TurnReasoning; steps?: readonly TurnStep[]; updates?: readonly string[]; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void;
}) {
  const title = useId();
  const updatesId = useId();
  const summaryId = useId();
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const closeAction = useRef(onClose);
  closeAction.current = onClose;
  useEffect(() => { setUpdatesOpen(false); setSummaryOpen(false); }, [reasoning.turnId, since]);
  useEffect(() => {
    const opener = anchor.current;
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeAction.current(); }
      if (event.key !== "Tab") return;
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]');
      if (!controls?.length) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); if (opener?.isConnected) opener.focus(); };
  }, [anchor]);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const box = anchor.current?.getBoundingClientRect();
    const height = panel.current?.getBoundingClientRect().height ?? 0;
    const left = Math.max(12, Math.min(box?.left ?? 12, window.innerWidth - 396));
    const above = (box?.top ?? window.innerHeight) - height - 8;
    const below = (box?.bottom ?? 0) + 8;
    const top = above >= 12 ? above : Math.max(12, Math.min(below, window.innerHeight - height - 12));
    setPlace({ left, top });
  }, [anchor, helpers.length, reasoning.text, steps.length, updates.length, updatesOpen, summaryOpen]);
  return createPortal(<div className="fixed inset-0 z-50 bg-black/10" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={title} className="fixed inset-x-3 bottom-3 flex max-h-[min(70vh,420px)] flex-col overflow-hidden rounded-2xl border border-hairline/70 bg-panel text-[13px] shadow-xl sm:inset-x-auto sm:bottom-auto sm:left-(--peek-left) sm:top-(--peek-top) sm:w-96" style={{ "--peek-left": `${place?.left ?? 12}px`, "--peek-top": `${place?.top ?? 12}px`, visibility: place ? undefined : "hidden" } as React.CSSProperties}>
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3 pb-2"><h2 id={title} className="text-[12px] font-medium text-ink-secondary">{t("chat.activity.peek")}</h2><button ref={close} type="button" className="rounded-lg p-1.5 text-ink-tertiary transition-colors hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={t("common.close")} onClick={onClose}><X size={15} aria-hidden="true" /></button></div>
      <div tabIndex={0} className="min-h-0 space-y-3.5 overflow-y-auto overscroll-contain px-4 pb-4 focus-visible:outline-2 focus-visible:-outline-offset-2">
        <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5">
          <CircleDot size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.75 text-ink-secondary" />
          <div className="min-w-0"><div className="flex items-start justify-between gap-3"><p className="break-words font-medium leading-5 text-ink">{label}</p>{since !== null && <WorkingTimer since={since} className="shrink-0 pt-0.5 text-[10.5px] text-ink-tertiary" />}</div>{reasoning.tokens !== null && <p className="mt-1 text-[10.5px] text-ink-tertiary">{t("chat.activity.thinkingTokens", { count: reasoning.tokens.toLocaleString() })}</p>}</div>
        </div>
        {steps.length > 0 && <div data-peek-steps=""><h3 className="mb-2 text-[11px] font-medium text-ink-tertiary">{t("chat.row.steps")}</h3><ul>{groupSteps(steps).map(step => <li key={step.id} className={cn(connectedStepClass, "grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 text-[12px] leading-4.5", step.state === "running" ? "text-ink" : "text-ink-secondary")}><span className="relative z-1 flex h-4.5 items-center justify-center bg-panel"><StepIcon state={step.state} /></span><span className="min-w-0 break-words">{step.label}{step.count > 1 && <span className="ms-1.5 text-ink-tertiary tabular-nums">×{step.count}</span>}</span></li>)}</ul></div>}
        {helpers.length > 0 && <ul className="border-t border-hairline/60 pt-3">{helpers.map(helper => <li key={helper.id} className={connectedStepClass}><HelperDetails helper={helper} />{helper.members?.length ? <ul className="mt-2.5 ms-6.5">{helper.members.map(member => <li key={member.id} className={connectedStepClass}><HelperDetails helper={member} /></li>)}</ul> : null}</li>)}</ul>}
        {updates.length > 0 && <div data-peek-updates=""><ProgressDisclosure id={updatesId} label={t("chat.row.updates")} open={updatesOpen} onToggle={() => setUpdatesOpen(value => !value)}><ul className="space-y-3">{updates.map((line, index) => <li key={index} className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-secondary">{line}</li>)}</ul></ProgressDisclosure></div>}
        <ProgressDisclosure id={summaryId} label={t("chat.activity.summary")} open={summaryOpen} onToggle={() => setSummaryOpen(value => !value)}>
          {reasoning.streamed ? <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-secondary">{reasoning.clipped ? "… " : ""}{reasoning.text}</p> : <p className="text-[11.5px] leading-relaxed text-ink-tertiary">{t("chat.activity.noSummary")}</p>}
        </ProgressDisclosure>
      </div>
    </section>
  </div>, document.body);
}
