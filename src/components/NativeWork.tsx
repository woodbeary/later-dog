import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, CirclePause, Loader2, Minus, Search, TriangleAlert, X } from "lucide-react";
import type { NativeActivity, NativeActor, NativeActorState, NativeRun, NativeRunDetail } from "../../shared/native-runs";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import { api } from "@/state/store";
import { nativeReceiptAnchors, receiveNativeRun, useNativeHistoryIncomplete } from "@/lib/native-runs-state";
import type { DogColor, DogState } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { DogAvatar } from "./Avatar";
import { WorkingTimer } from "./WorkingIndicator";

export const NATIVE_PUPPY_LIMIT = 5;
const stateText: Record<NativeActorState, string> = { running: "Working", waiting: "Waiting", paused: "Paused", done: "Done", failed: "Failed", stopped: "Stopped" };
const dogState: Record<NativeActorState, DogState> = { running: "working", waiting: "thinking", paused: "sleeping", done: "happy", failed: "sad", stopped: "sleeping" };
export const nativePuppies = (run: NativeRun): NativeActor[] => run.actors.filter(actor => actor.kind === "subagent");
interface StopAttempt { id: number; status: "requested" | "unconfirmed"; at: number; state: NativeActorState; generation?: string; }
const canStopActor = (run: NativeRun, actorId: string, attempt?: StopAttempt) => run.observation === "live" && run.actors.some(actor => actor.id === actorId && actor.canStop && (actor.state === "running" || actor.state === "waiting") && (!attempt || actor.state === attempt.state && actor.generation === attempt.generation));

function StateIcon({ state }: { state: NativeActorState }) {
  const Icon = state === "running" ? Loader2 : state === "done" ? Check : state === "failed" ? TriangleAlert : state === "paused" ? CirclePause : Minus;
  return <Icon size={14} aria-label={stateText[state]} className={cn("shrink-0", state === "running" && "animate-spin motion-reduce:animate-none", state === "failed" && "text-warning")} />;
}

export function actorAncestry(run: NativeRun, actor: NativeActor): NativeActor[] {
  const parents: NativeActor[] = [];
  const seen = new Set([actor.id]);
  let parentId = actor.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = run.actors.find(row => row.id === parentId);
    if (!parent) break;
    parents.unshift(parent);
    parentId = parent.parentId;
  }
  return parents;
}

function WorkActivity({ activity }: { activity: NativeActivity }) {
  return <li className="min-w-0 border-b border-hairline/40 py-3 last:border-b-0">
    <div className="flex items-start gap-2 text-[12px] text-ink-secondary"><StateIcon state={activity.state} />{activity.kind === "search" && <Search size={13} aria-hidden="true" />}<span className="min-w-0 break-words font-medium text-ink">{activity.label}</span><span className="ml-auto shrink-0 text-[10px]">{stateText[activity.state]}</span></div>
    {activity.text && <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-secondary">{activity.text}</p>}
    {(activity.input || activity.output) && <details className="mt-2 text-[11px] text-ink-secondary"><summary className="w-fit cursor-pointer">Details</summary>{activity.input && <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-2">{activity.input}</pre>}{activity.output && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-2">{activity.output}</pre>}</details>}
    {!!activity.links?.length && <ul className="mt-2 space-y-1 text-[12px]">{activity.links.filter(link => /^https?:\/\//i.test(link.url)).map(link => <li key={link.url}><a className="break-words text-accent hover:underline" href={link.url} target="_blank" rel="noreferrer noopener">{link.title || link.url}</a></li>)}</ul>}
    {activity.truncated && <p className="mt-1 text-[10px] text-ink-tertiary">This recorded preview was shortened.</p>}
  </li>;
}

export function NativeWorkDetail({ run, selectedActorId, onSelect, onClose }: { run: NativeRun; selectedActorId: string; onSelect: (id: string) => void; onClose: () => void }) {
  const title = useId();
  const close = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [activities, setActivities] = useState<NativeActivity[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const [stopAttempts, setStopAttempts] = useState<Record<string, StopAttempt>>({});
  const stopSerial = useRef(0);
  const lifetime = useRef(0);
  const request = useRef(0);
  const currentRun = useRef(run);
  currentRun.current = run;
  const pageCursors = useRef<Array<string | undefined>>([undefined]);
  const busy = useRef(false);
  const selected = run.actors.find(actor => actor.id === selectedActorId) ?? run.actors[0];
  const selectedRef = useRef(onClose);
  selectedRef.current = onClose;
  useEffect(() => { setStopping(false); setStopAttempts({}); return () => { lifetime.current += 1; }; }, [run.id]);
  useEffect(() => setStopAttempts(before => Object.fromEntries(Object.entries(before).filter(([id, attempt]) => canStopActor(run, id, attempt)))), [run]);
  const refreshStop = useCallback(async () => {
    const epoch = lifetime.current;
    const attemptAtRead = stopSerial.current;
    try {
      const detail = await api<NativeRunDetail>(`/api/threads/${encodeURIComponent(run.threadId)}/runs/${encodeURIComponent(run.id)}?limit=200`);
      if (epoch !== lifetime.current || attemptAtRead !== stopSerial.current || detail.run.revision < currentRun.current.revision) return;
      receiveNativeRun(detail.run);
      setStopAttempts(before => Object.fromEntries(Object.entries(before).filter(([id, attempt]) => attempt.id > attemptAtRead || canStopActor(detail.run, id, attempt))));
    } catch (cause) { if (epoch === lifetime.current) setError(cause instanceof Error ? cause.message : "Could not refresh this work."); }
  }, [run.id, run.threadId]);
  useEffect(() => {
    const timers = Object.entries(stopAttempts).filter(([, attempt]) => attempt.status === "requested").map(([id, attempt]) => setTimeout(() => {
      setStopAttempts(before => before[id]?.id === attempt.id ? { ...before, [id]: { ...attempt, status: "unconfirmed" } } : before);
      void refreshStop();
    }, Math.max(0, attempt.at + 15_000 - Date.now())));
    return () => timers.forEach(clearTimeout);
  }, [stopAttempts, refreshStop]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); selectedRef.current(); }
      if (event.key !== "Tab") return;
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], summary, [tabindex="0"]');
      if (!controls?.length) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (opener?.isConnected) opener.focus(); request.current += 1; };
  }, [run.id]);
  useEffect(() => {
    let active = true;
    let revision = -1;
    pageCursors.current = [undefined];
    setActivities([]);
    setCursor(undefined);
    const load = () => {
      if (busy.current || currentRun.current.revision <= revision) return;
      busy.current = true;
      revision = currentRun.current.revision;
      const current = ++request.current;
      setLoading(true);
      void Promise.all(pageCursors.current.map(cursor => api<NativeRunDetail>(`/api/threads/${encodeURIComponent(run.threadId)}/runs/${encodeURIComponent(run.id)}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`))).then(pages => {
        if (!active || current !== request.current) return;
        setActivities([...new Map(pages.flatMap(page => page.activities).map(activity => [activity.id, activity])).values()]);
        setCursor(pages.at(-1)?.nextCursor);
        setError(undefined);
        for (const page of pages) receiveNativeRun(page.run);
      }).catch(cause => { if (active && current === request.current) { revision = -1; setError(cause instanceof Error ? cause.message : "Work details are unavailable."); } }).finally(() => { busy.current = false; if (active && current === request.current) setLoading(false); });
    };
    load();
    const timer = setInterval(load, 800);
    return () => { active = false; clearInterval(timer); };
  }, [run.id, run.threadId]);
  const loadMore = async () => {
    if (!cursor || loading || busy.current) return;
    busy.current = true;
    const current = request.current;
    setLoading(true);
    try {
      const detail = await api<NativeRunDetail>(`/api/threads/${encodeURIComponent(run.threadId)}/runs/${encodeURIComponent(run.id)}?limit=200&cursor=${encodeURIComponent(cursor)}`);
      if (current !== request.current) return;
      pageCursors.current.push(cursor);
      setActivities(before => [...new Map([...before, ...detail.activities].map(activity => [activity.id, activity])).values()]);
      setCursor(detail.nextCursor);
      receiveNativeRun(detail.run);
    } catch (cause) { if (current === request.current) setError(cause instanceof Error ? cause.message : "Could not load more activity."); }
    finally { busy.current = false; if (current === request.current) setLoading(false); }
  };
  const stop = async () => {
    if (!selected || !canStopActor(run, selected.id) || stopping || stopAttempts[selected.id]?.status === "requested") return;
    const epoch = lifetime.current;
    const attempt: StopAttempt = { id: ++stopSerial.current, status: "requested", at: Date.now(), state: selected.state, generation: selected.generation };
    setStopping(true);
    try {
      await api(`/api/threads/${encodeURIComponent(run.threadId)}/runs/${encodeURIComponent(run.id)}/actors/${encodeURIComponent(selected.id)}/stop`, { method: "POST" });
      if (epoch === lifetime.current && canStopActor(currentRun.current, selected.id, attempt)) setStopAttempts(before => ({ ...before, [selected.id]: { ...attempt, at: Date.now() } }));
    } catch (cause) { if (epoch === lifetime.current) setError(cause instanceof Error ? cause.message : "Could not stop this helper."); }
    finally { if (epoch === lifetime.current) setStopping(false); }
  };
  const shown = activities.filter(activity => activity.actorId === selected?.id);
  const ancestry = selected ? actorAncestry(run, selected) : [];
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-3" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={title} className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-hairline/70 bg-panel text-ink shadow-xl">
      <div className="flex items-center justify-between border-b border-hairline/50 px-4 py-3"><h2 id={title} className="text-[14px] font-medium">Work details</h2>{run.observation === "live" && <WorkingTimer since={run.startedAt} className="ml-auto mr-3 text-[11px] tabular-nums text-ink-tertiary" />}<button ref={close} type="button" aria-label="Close work details" onClick={onClose} className="rounded-lg p-1.5 text-ink-secondary hover:bg-control"><X size={17} /></button></div>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="Agents and tasks" className="flex max-h-40 shrink-0 gap-1 overflow-auto border-b border-hairline/50 p-2 sm:max-h-none sm:w-52 sm:flex-col sm:border-r sm:border-b-0">{run.actors.map(actor => <button key={actor.id} type="button" aria-pressed={selected?.id === actor.id} onClick={() => onSelect(actor.id)} className={cn("flex shrink-0 items-start gap-2 rounded-lg px-2 py-2 text-left text-[12px] sm:shrink", selected?.id === actor.id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60")}><StateIcon state={actor.state} /><span className="min-w-0"><span className="block break-words">{actor.label}</span><span className="mt-0.5 block text-[10px] text-ink-tertiary">{actor.kind === "subagent" ? "Puppy" : actor.kind === "parent" ? "Main agent" : actor.kind === "workflow" ? "Workflow" : "Task"} · {stateText[actor.state]}</span></span></button>)}</nav>
        <div tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-3">
          {!!ancestry.length && <div className="mb-2 flex flex-wrap items-center gap-1 text-[10px] text-ink-tertiary">{ancestry.map(actor => <span key={actor.id} className="inline-flex items-center gap-1"><button type="button" onClick={() => onSelect(actor.id)} className="hover:text-ink">{actor.label}</button><ChevronRight size={11} /></span>)}</div>}
          {selected && <div className="mb-2"><div className="flex items-start justify-between gap-3"><h3 className="text-[13px] font-medium">{selected.label}</h3>{canStopActor(run, selected.id) && <button type="button" disabled={stopping || stopAttempts[selected.id]?.status === "requested"} onClick={() => void stop()} className="rounded-lg border border-hairline px-2 py-1 text-[11px] hover:bg-control disabled:opacity-50">{stopAttempts[selected.id]?.status === "requested" ? "Stop requested" : stopping ? "Stopping…" : stopAttempts[selected.id]?.status === "unconfirmed" ? "Try stop again" : "Stop helper"}</button>}</div>{stopAttempts[selected.id]?.status === "unconfirmed" && <div className="mt-2 text-[12px] text-ink-secondary"><p>The stop hasn't been confirmed. The last reported state is shown.</p><button type="button" className="mt-1 text-accent hover:underline" onClick={() => void refreshStop()}>Refresh work</button></div>}{selected.task && <p className="mt-2 whitespace-pre-wrap text-[12px] text-ink-secondary">{selected.task}</p>}{selected.activity && <p className="mt-1 text-[12px] text-ink-secondary">{selected.activity}</p>}{selected.summary && <p className="mt-2 whitespace-pre-wrap text-[12px] text-ink-secondary">{selected.summary}</p>}</div>}
          {error && <p role="alert" className="my-2 text-[12px] text-warning">{error}</p>}
          {!shown.length && <p className="py-5 text-[12px] text-ink-tertiary">{loading ? "Loading activity…" : "No activity was reported for this agent in this page."}</p>}
          <ul>{shown.map(activity => <WorkActivity key={activity.id} activity={activity} />)}</ul>
          {cursor && <button type="button" onClick={() => void loadMore()} disabled={loading} className="my-3 rounded-lg border border-hairline px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-control disabled:opacity-50">{loading ? "Loading…" : "Load more activity"}</button>}
        </div>
      </div>
      <details className="shrink-0 border-t border-hairline/50 px-4 py-2 text-[11px] text-ink-secondary"><summary className="cursor-pointer">{run.provider === "claudeAgent" ? "Claude Code" : /codex/i.test(run.provider) ? "Codex" : run.provider}{run.providerVersion ? ` ${run.providerVersion}` : " · version not reported"} · {run.observation === "partial" ? "Partial activity" : run.observation === "interrupted" ? "Observation interrupted" : run.observation === "live" ? "Live" : "Recorded"}</summary><div className="max-h-32 overflow-auto py-2"><ul className="space-y-1">{run.limitations.map((line, index) => <li key={index}>{line}</li>)}</ul>{run.truncated && <p className="mt-1">Some activity exceeded the recording limit.</p>}{!run.limitations.length && <p>No additional limitations were reported by this harness.</p>}</div></details>
    </section>
  </div>, document.body);
}

export function NativeWork({ run, color = "yellow", bodyId, live = false, label, avatar }: { run: NativeRun; color?: DogColor; bodyId?: MascotBodyId | null; live?: boolean; label?: string; avatar?: ReactNode }) {
  const [selected, setSelected] = useState<string | null>(null);
  const puppies = nativePuppies(run);
  useEffect(() => setSelected(null), [run.id]);
  const reduced = typeof window !== "undefined" && (document.documentElement.dataset.reducedMotion === "true" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const current = run.currentActivity;
  const currentLabel = current?.kind === "search" ? "Searching" : current?.kind === "request" ? "Waiting for an answer" : current?.kind === "reasoning" ? "Thinking" : current?.kind === "message" ? "Writing" : current?.label;
  return <div data-native-work={run.id} className="flex flex-wrap items-center gap-1.5 py-1">
    <button type="button" onClick={() => setSelected(current?.actorId ?? "parent")} aria-label={live ? t("chat.activity.peek") : undefined} aria-haspopup="dialog" aria-expanded={selected !== null} className="flex min-h-8 items-center gap-2 rounded-lg text-[12px] text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2">{avatar}{live ? currentLabel || label || "Working" : "View work"}{live && <WorkingTimer since={run.startedAt} className="text-[10px] tabular-nums text-ink-tertiary" />}{!live && <ChevronRight size={12} aria-hidden="true" />}{run.observation === "interrupted" && <span className="text-[10px] text-ink-tertiary">Interrupted</span>}{run.failureCount > 0 && <span className="text-[10px] text-warning">Issue recorded</span>}</button>
    {!!puppies.length && <span className="flex items-center gap-0.5" aria-label={`${puppies.length} native puppies`}>{puppies.slice(0, NATIVE_PUPPY_LIMIT).map(actor => <button key={actor.id} type="button" aria-label={`View ${actor.label} · ${stateText[actor.state]}`} title={`${actor.label} · ${stateText[actor.state]}`} onClick={() => setSelected(actor.id)} className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2"><DogAvatar color={color} bodyId={bodyId ?? undefined} size={23} state={dogState[actor.state]} label={actor.label} trackPointer={false} animated={!reduced && live} /></button>)}{puppies.length > NATIVE_PUPPY_LIMIT && <button type="button" onClick={() => setSelected(puppies[NATIVE_PUPPY_LIMIT]!.id)} aria-label={`View ${puppies.length - NATIVE_PUPPY_LIMIT} more puppies`} className="rounded-lg px-1.5 text-[11px] tabular-nums text-ink-secondary">+{puppies.length - NATIVE_PUPPY_LIMIT}</button>}</span>}
    {selected !== null && <NativeWorkDetail run={run} selectedActorId={selected} onSelect={setSelected} onClose={() => setSelected(null)} />}
  </div>;
}

export function NativeWorkFallbacks({ runs, messages, ownerForRun }: { runs: readonly NativeRun[]; messages: readonly { id: string; turnId?: string; role: string; kind: string; at: number }[]; ownerForRun?: (run: NativeRun) => { color: DogColor; mascotBody?: MascotBodyId | null } | undefined }) {
  const anchored = new Set([...nativeReceiptAnchors(runs, messages).values()].flat().map(run => run.id));
  const unanchored = runs.filter(run => (run.endedAt || run.observation !== "live") && !anchored.has(run.id));
  const firstAt = messages[0]?.at ?? Infinity;
  const recent = unanchored.filter(run => run.startedAt >= firstAt || !messages.length);
  const earlier = unanchored.filter(run => run.startedAt < firstAt && messages.length);
  if (!unanchored.length) return null;
  const receipt = (run: NativeRun) => {
    const owner = ownerForRun?.(run);
    return <NativeWork key={run.id} run={run} color={owner?.color} bodyId={owner?.mascotBody} />;
  };
  return <div className="space-y-1" data-native-work-fallbacks="">{recent.map(receipt)}{!!earlier.length && <details className="text-[11px] text-ink-tertiary"><summary className="w-fit cursor-pointer">Earlier work · {earlier.length}</summary><div className="max-h-60 overflow-auto py-2">{earlier.map(run => <div key={run.id} className="flex flex-wrap items-center gap-3"><time className="text-[10px]" dateTime={new Date(run.startedAt).toISOString()}>{new Date(run.startedAt).toLocaleString()}</time>{receipt(run)}</div>)}</div></details>}</div>;
}

export function NativeHistoryNotice({ threadId }: { threadId: string }) {
  return useNativeHistoryIncomplete(threadId) ? <p className="py-1 text-[11px] text-ink-tertiary">Some earlier work is no longer available.</p> : null;
}
