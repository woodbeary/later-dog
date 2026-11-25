import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";
import "../work-panel.css";
import type { NativeActivity, NativeRun, NativeRunDetail } from "../../shared/native-runs";
import type { WirePlan } from "../../shared/dog-plan";
import type { CloudTaskSummary } from "../../shared/cloud-task";
import type { LiveStep } from "../../shared/step-words";
import { api } from "@/lib/api";
import { useTurnReasoning } from "@/lib/turn-reasoning";
import { useNativeHistoryIncomplete } from "@/lib/native-runs-state";
import { ageWords } from "../../shared/step-words";
import { NativeWorkDetail } from "./NativeWork";
import { useNativeRuns } from "@/lib/native-runs-state";
import { dogCloudTasks, refreshCloudTask, stopCloudTask } from "@/lib/cloud-tasks";
import { backWorkPanel, closeWorkPanel, openWorkPanel, useWorkPanel, workPanelCanGoBack, workPanelOpener, type WorkPanelPage } from "@/lib/work-panel";
import { helperRows, helpingWords, panelTitle, PANEL_WORDS, sideJobCards, stepDetail, stepRows, todoRows, type HelpingDog, type HelperRow, type SideJobCard } from "@/lib/work-panel-model";
import { useStoreDispatch, useStoreSelector } from "@/state/store-selectors";
import { BotAvatar } from "./Avatar";
import { WorkTodo } from "./WorkTodo";
import { WorkHelpers } from "./WorkHelpers";
import { WorkSteps } from "./WorkSteps";
import { StepPage } from "./StepPage";
import { SideJobs } from "./SideJobs";
import { SideJobPage } from "./SideJobPage";

export interface WorkPanelData {
  now: number;
  working: boolean;
  run?: NativeRun;
  activities: readonly NativeActivity[];
  plan?: WirePlan | null;
  helpers: readonly HelpingDog[];
  jobs: readonly CloudTaskSummary[];
  reasoning?: string;
  account?: string;
  model?: string;
  records?: readonly { id: string; text: string }[];
  historyIncomplete?: boolean;
}

export interface WorkPanelActions {
  face: (botId: string) => ReactNode;
  openDog: (row: HelperRow) => void;
  stopJob: (card: SideJobCard) => Promise<void>;
}

const newest = (runs: readonly NativeRun[]) => [...runs].sort((a, b) => b.startedAt - a.startedAt);

function pickRun(runs: readonly NativeRun[], page: WorkPanelPage): NativeRun | undefined {
  if ((page.kind === "work" || page.kind === "step" || page.kind === "puppy") && page.runId) return runs.find(run => run.id === page.runId);
  const sorted = newest(runs);
  return sorted.find(run => run.observation === "live") ?? sorted[0];
}

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function useRunActivities(run: NativeRun | undefined): NativeActivity[] {
  const [activities, setActivities] = useState<NativeActivity[]>([]);
  const key = run ? [run.threadId, run.id, run.activityCount, run.currentActivity?.id ?? "", run.failureCount, run.observation].join("\u0000") : "";
  useEffect(() => {
    if (!run) { setActivities([]); return; }
    let live = true;
    const base = `/api/threads/${encodeURIComponent(run.threadId)}/runs/${encodeURIComponent(run.id)}?limit=200`;
    void (async () => {
      const all: NativeActivity[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const detail = await api<NativeRunDetail>(cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base);
        all.push(...detail.activities);
        cursor = detail.nextCursor;
        if (!cursor) break;
      }
      if (live) setActivities(all);
    })().catch(() => undefined);
    return () => { live = false; };
  }, [key]);
  return activities;
}

function useDogJobs(botId: string, threadId: string, open: boolean): [CloudTaskSummary[], () => void] {
  const [jobs, setJobs] = useState<CloudTaskSummary[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => void dogCloudTasks(botId).then(all => { if (live) setJobs(all.filter(job => job.conversationId === threadId)); }, () => undefined);
    load();
    const timer = setInterval(load, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [botId, threadId, open, tick]);
  return [jobs, () => setTick(value => value + 1)];
}

type StoreDog = { id: string; name: string; threadId?: string; busy?: boolean; plan?: WirePlan | null; waitingOn?: Array<{ botId: string; name: string; threadId?: string; state?: "queued" | "running" | "needsYou" }>; tasks?: Array<{ threadId: string; busy?: boolean; plan?: WirePlan | null; waitingOn?: StoreDog["waitingOn"] }> } & { step?: LiveStep | null };

function usePanelData(page: WorkPanelPage | null, botId: string): { data: WorkPanelData; refreshJobs: () => void } {
  const threadId = page?.threadId ?? null;
  const runs = useNativeRuns(threadId);
  const run = page ? pickRun(runs, page) : undefined;
  const activities = useRunActivities(page ? run : undefined);
  const dogs = useStoreSelector(state => state.bots) as unknown as StoreDog[];
  const groups = useStoreSelector(state => state.groups);
  const messages = useStoreSelector(state => state.bots.find(dog => dog.id === botId)?.messages);
  const instances = useStoreSelector(state => state.instances);
  const reasoning = useTurnReasoning(threadId);
  const historyIncomplete = useNativeHistoryIncomplete(threadId ?? "");
  const [jobs, refreshJobs] = useDogJobs(botId, threadId ?? "", Boolean(page));
  const now = useClock(Boolean(page));
  const data = useMemo<WorkPanelData>(() => {
    const dog = dogs.find(candidate => candidate.id === botId);
    const group = groups.find(candidate => candidate.threadId === threadId);
    const source = group ?? dog?.tasks?.find(task => task.threadId === threadId) ?? dog;
    const owner = group ? undefined : source as StoreDog | undefined;
    const helpers = (owner?.waitingOn ?? []).map(wait => ({ ...wait, step: dogs.find(candidate => candidate.id === wait.botId)?.step ?? null }));
    const rows = group?.messages ?? messages ?? [];
    const records = rows.filter(message => message.tool?.carry || message.tool?.statusLine === "live").map(message => ({ id: message.id, text: message.tool?.name.replace(/^notice:\s*/, "") ?? "" }));
    const parent = run?.actors.find(actor => actor.kind === "parent");
    return { now, working: group ? Boolean(group.working || group.busyBotId) : Boolean(owner?.busy), run, activities, plan: owner?.plan ?? null, helpers, jobs, reasoning: reasoning.text, account: instances.find(instance => instance.instanceId === run?.providerInstanceId)?.displayName, model: parent?.model, records, historyIncomplete };
  }, [dogs, groups, messages, instances, reasoning, historyIncomplete, botId, threadId, now, run, activities, jobs]);
  return { data, refreshJobs };
}

export function WorkPanelView({ page, botName, data, actions, hoveredStep }: { page: WorkPanelPage; botName: string; data: WorkPanelData; actions: WorkPanelActions; hoveredStep?: string }) {
  const steps = stepRows(data.run, data.activities, data.now);
  const sideJobs = sideJobCards(data.run, data.jobs, data.now);
  const todo = todoRows(data.plan, data.working);
  const helpers = helperRows(data.helpers, data.now);
  const activity = page.kind === "step" ? data.activities.find(item => item.id === page.activityId) : undefined;
  const job = page.kind === "side-job" ? [...sideJobs.running, ...sideJobs.finished].find(card => card.id === page.jobId) : undefined;
  const puppy = page.kind === "puppy" ? data.run?.actors.find(actor => actor.id === page.actorId) : undefined;
  const pushedTitle = page.kind === "puppy" ? puppy?.label : page.kind === "step" ? (activity ? stepDetail(activity).title : "") : page.kind === "side-job" ? job?.title : undefined;
  const baseTitle = panelTitle(page, botName, pushedTitle, data.working);
  const age = page.kind === "work" && data.run ? ageWords((data.run.endedAt ?? data.now) - data.run.startedAt) : null;
  const title = age ? `${baseTitle} · ${age}` : baseTitle;
  const heading = useRef<HTMLHeadingElement>(null);
  const focusKey = `${page.kind}:${page.kind === "puppy" ? page.actorId : page.threadId}`;
  useEffect(() => {
    const frame = requestAnimationFrame(() => heading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusKey]);
  const back = workPanelCanGoBack();
  const sections = page.kind === "work" ? [todo.length > 0, helpers.length > 0, true].filter(Boolean).length : 0;
  return (
    <aside data-work-panel data-page={page.kind} aria-label={title || botName} className="work-panel animate-panel-in">
      <header className="work-panel-header">
        <button type="button" className="work-panel-close" onClick={back ? backWorkPanel : closeWorkPanel} aria-label={back ? PANEL_WORDS.back : PANEL_WORDS.close}>
          {back ? <ChevronLeft size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
        </button>
        <h2 ref={heading} tabIndex={-1} className="work-panel-title">{title}</h2>
      </header>
      <div className="work-panel-body">
        {page.kind === "work" && (
          <>
            {data.reasoning && <details className="work-panel-note"><summary className="cursor-pointer">Thinking</summary><p className="mt-2 whitespace-pre-wrap break-words">{data.reasoning}</p></details>}
            {Boolean(data.run?.actors.some(actor => actor.kind !== "parent")) && <>
              <div className="work-panel-section">Puppies</div>
              <div className="flex flex-col gap-1">
                {data.run!.actors.filter(actor => actor.kind !== "parent").map(actor => <button key={actor.id} type="button" className="rounded-lg px-2 py-3 text-left text-[14px] hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2" onClick={() => openWorkPanel({ kind: "puppy", threadId: page.threadId, runId: data.run!.id, actorId: actor.id })}>
                  <span className="block break-words">{actor.label}</span><span className="text-[12px] text-ink-secondary">{actor.state === "running" ? "Working" : actor.state === "waiting" ? "Waiting" : actor.state === "done" ? "Done" : actor.state === "failed" ? "Couldn’t finish" : "Stopped"}</span>
                </button>)}
              </div>
            </>}
            {todo.length > 0 && <><div className="work-panel-section">{PANEL_WORDS.todo}</div><WorkTodo rows={todo} /></>}
            {helpers.length > 0 && <><div className="work-panel-section">{helpingWords(botName)}</div><WorkHelpers rows={helpers} face={actions.face} onOpen={actions.openDog} /></>}
            {sections > 1 && <div className="work-panel-section">{PANEL_WORDS.steps}</div>}
            {steps.rows.length || steps.trimmed
              ? <WorkSteps rows={steps.rows} trimmed={steps.trimmed} hovered={hoveredStep} onOpen={row => { const activityId = row.live ? data.run?.currentActivity?.id : row.id; if (activityId) openWorkPanel({ kind: "step", threadId: page.threadId, runId: row.runId, activityId }); }} />
              : <p className="work-panel-note">{PANEL_WORDS.noSteps}</p>}
          </>
        )}
        {page.kind === "puppy" && data.run && <NativeWorkDetail embedded run={data.run} selectedActorId={page.actorId} onSelect={actorId => openWorkPanel({ kind: "puppy", threadId: page.threadId, runId: data.run!.id, actorId })} onClose={backWorkPanel} />}
        {page.kind === "side-jobs" && <SideJobs running={sideJobs.running} finished={sideJobs.finished} onOpen={card => openWorkPanel({ kind: "side-job", threadId: page.threadId, jobId: card.id })} />}
        {page.kind === "step" && <StepPage activity={activity} />}
        {page.kind === "side-job" && <SideJobPage key={page.jobId} card={job} botName={botName} now={data.now} onStop={actions.stopJob} />}
        {page.kind === "work" && (data.account || data.model) && <p className="work-panel-note">{[data.account, data.model].filter(Boolean).join(" · ")}</p>}
        {page.kind === "work" && Boolean(data.records?.length) && <details className="work-panel-note"><summary className="cursor-pointer">How it ran</summary>{data.records!.map(record => <p key={record.id} className="mt-2 break-words">{record.text}</p>)}</details>}
        {data.historyIncomplete && <p className="work-panel-note">Some earlier work is no longer available.</p>}
      </div>
    </aside>
  );
}

export function WorkPanel(props: { botId: string; botName: string }) {
  const page = useWorkPanel();
  const dispatch = useStoreDispatch();
  const dogs = useStoreSelector(state => state.bots);
  const { data, refreshJobs } = usePanelData(page, props.botId);
  const shownFor = useRef(props.botId);
  const returnTo = useRef<HTMLElement | null>(null);
  const open = page !== null;
  useEffect(() => {
    if (open) {
      returnTo.current = workPanelOpener();
      return;
    }
    const back = returnTo.current;
    returnTo.current = null;
    const frame = requestAnimationFrame(() => {
      if (back?.isConnected && (document.activeElement === document.body || document.activeElement === null)) back.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    if (shownFor.current !== props.botId) closeWorkPanel();
    shownFor.current = props.botId;
  }, [props.botId]);
  useEffect(() => {
    if (!page) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) closeWorkPanel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [page]);
  if (!page) return null;
  const actions: WorkPanelActions = {
    face: botId => { const dog = dogs.find(candidate => candidate.id === botId); return dog ? <BotAvatar bot={dog} size={20} animated={false} trackPointer={false} /> : null; },
    openDog: row => { closeWorkPanel(); dispatch({ type: "select", id: row.botId }); },
    stopJob: async card => {
      const jobId = card.id.replace(/^job:/, "");
      await stopCloudTask(jobId);
      await refreshCloudTask(jobId).catch(() => undefined);
      refreshJobs();
    },
  };
  return <WorkPanelView page={page} botName={props.botName} data={data} actions={actions} />;
}

