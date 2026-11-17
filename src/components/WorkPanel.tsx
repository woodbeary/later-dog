import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";
import "../work-panel.css";
import type { NativeActivity, NativeRun, NativeRunDetail } from "../../shared/native-runs";
import type { WirePlan } from "../../shared/dog-plan";
import type { CloudTaskSummary } from "../../shared/cloud-task";
import type { LiveStep } from "../../shared/step-words";
import { api } from "@/lib/api";
import { useNativeRuns } from "@/lib/native-runs-state";
import { dogCloudTasks, refreshCloudTask, stopCloudTask } from "@/lib/cloud-tasks";
import { backWorkPanel, closeWorkPanel, openWorkPanel, useWorkPanel, workPanelCanGoBack, type WorkPanelPage } from "@/lib/work-panel";
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
}

export interface WorkPanelActions {
  face: (botId: string) => ReactNode;
  openDog: (row: HelperRow) => void;
  stopJob: (card: SideJobCard) => Promise<void>;
}

const newest = (runs: readonly NativeRun[]) => [...runs].sort((a, b) => b.startedAt - a.startedAt);

function pickRun(runs: readonly NativeRun[], page: WorkPanelPage): NativeRun | undefined {
  if ((page.kind === "work" || page.kind === "step") && page.runId) return runs.find(run => run.id === page.runId);
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
  const [jobs, refreshJobs] = useDogJobs(botId, threadId ?? "", Boolean(page));
  const now = useClock(Boolean(page));
  const data = useMemo<WorkPanelData>(() => {
    const dog = dogs.find(candidate => candidate.id === botId);
    const source = dog?.tasks?.find(task => task.threadId === threadId) ?? dog;
    const helpers = (source?.waitingOn ?? []).map(wait => ({ ...wait, step: dogs.find(candidate => candidate.id === wait.botId)?.step ?? null }));
    return { now, working: Boolean(source?.busy), run, activities, plan: source?.plan ?? null, helpers, jobs };
  }, [dogs, botId, threadId, now, run, activities, jobs]);
  return { data, refreshJobs };
}

export function WorkPanelView({ page, botName, data, actions, hoveredStep }: { page: WorkPanelPage; botName: string; data: WorkPanelData; actions: WorkPanelActions; hoveredStep?: string }) {
  const steps = stepRows(data.run, data.activities, data.now);
  const sideJobs = sideJobCards(data.run, data.jobs, data.now);
  const todo = todoRows(data.plan, data.working);
  const helpers = helperRows(data.helpers, data.now);
  const activity = page.kind === "step" ? data.activities.find(item => item.id === page.activityId) : undefined;
  const job = page.kind === "side-job" ? [...sideJobs.running, ...sideJobs.finished].find(card => card.id === page.jobId) : undefined;
  const pushedTitle = page.kind === "step" ? (activity ? stepDetail(activity).title : "") : page.kind === "side-job" ? job?.title : undefined;
  const title = panelTitle(page, botName, pushedTitle, data.working);
  const back = workPanelCanGoBack();
  const sections = page.kind === "work" ? [todo.length > 0, helpers.length > 0, true].filter(Boolean).length : 0;
  return (
    <aside data-work-panel data-page={page.kind} aria-label={title || botName} className="work-panel animate-panel-in">
      <header className="work-panel-header">
        <button type="button" className="work-panel-close" onClick={back ? backWorkPanel : closeWorkPanel} aria-label={back ? PANEL_WORDS.back : PANEL_WORDS.close}>
          {back ? <ChevronLeft size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
        </button>
        <h2 className="work-panel-title">{title}</h2>
      </header>
      <div className="work-panel-body">
        {page.kind === "work" && (
          <>
            {todo.length > 0 && <><div className="work-panel-section">{PANEL_WORDS.todo}</div><WorkTodo rows={todo} /></>}
            {helpers.length > 0 && <><div className="work-panel-section">{helpingWords(botName)}</div><WorkHelpers rows={helpers} face={actions.face} onOpen={actions.openDog} /></>}
            {sections > 1 && <div className="work-panel-section">{PANEL_WORDS.steps}</div>}
            {steps.rows.length || steps.trimmed
              ? <WorkSteps rows={steps.rows} trimmed={steps.trimmed} hovered={hoveredStep} onOpen={row => { if (!row.live) openWorkPanel({ kind: "step", threadId: page.threadId, runId: row.runId, activityId: row.id }); }} />
              : <p className="work-panel-note">{PANEL_WORDS.noSteps}</p>}
          </>
        )}
        {page.kind === "side-jobs" && <SideJobs running={sideJobs.running} finished={sideJobs.finished} onOpen={card => openWorkPanel({ kind: "side-job", threadId: page.threadId, jobId: card.id })} />}
        {page.kind === "step" && <StepPage activity={activity} />}
        {page.kind === "side-job" && <SideJobPage key={page.jobId} card={job} botName={botName} now={data.now} onStop={actions.stopJob} />}
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

