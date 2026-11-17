import type { NativeActivity, NativeActor, NativeRun } from "../../shared/native-runs";
import type { WirePlan } from "../../shared/dog-plan";
import type { CloudTaskSummary } from "../../shared/cloud-task";
import { ageWords, goingWords, lastMovedWords, liveStep, outcomeKindOfTool, stepLabel, stepPhrase, stepTime, type LiveStep, type OutcomeKind } from "../../shared/step-words";
import type { WorkPanelPage } from "./work-panel";
import { t } from "./i18n";
import type { LocaleKey } from "@/locales";

export const PANEL_WORDS = {
  get close() { return t("workPanel.close"); },
  get back() { return t("workPanel.back"); },
  get todo() { return t("workPanel.todo"); },
  get steps() { return t("workPanel.steps"); },
  get failed() { return t("workPanel.failed"); },
  get trimmed() { return t("workPanel.trimmed"); },
  get sideJobs() { return t("workPanel.sideJobs"); },
  get nothingRunning() { return t("workPanel.nothingRunning"); },
  get finishedToday() { return t("workPanel.finishedToday"); },
  get needsAnswer() { return t("workPanel.needsAnswer"); },
  get cameBack() { return t("workPanel.cameBack"); },
  get shortened() { return t("workPanel.shortened"); },
  get hidden() { return t("workPanel.hidden"); },
  get copy() { return t("workPanel.copy"); },
  get copied() { return t("workPanel.copied"); },
  get doing() { return t("workPanel.doing"); },
  get stop() { return t("workPanel.stop"); },
  get stopping() { return t("workPanel.stopping"); },
  get stopFailed() { return t("workPanel.stopFailed"); },
  get cancel() { return t("workPanel.cancel"); },
  get stopConfirm() { return t("workPanel.stopConfirm"); },
  get loading() { return t("workPanel.loading"); },
  get noSteps() { return t("workPanel.noSteps"); },
};

export const helpingWords = (name: string) => t("workPanel.helping", { name });
export const stopQuestion = (name: string) => t("workPanel.stopQuestion", { name });
export const startedWords = (at: number, now: number) => t("workPanel.started", { time: stepTime(at, now) });
export const lastMovedLine = (ms: number) => t("workPanel.lastMoved", { time: lastMovedWords(ms) });

export type StepGlyphKind = "spinner" | "play" | "pencil" | "page" | "magnifier" | "screen" | "paw" | "cloud";

export interface StepRow { id: string; runId: string; label: string; time: string; glyph: StepGlyphKind; live: boolean; failed: boolean }
export interface TodoRow { text: string; mark: "done" | "working" | "current" | "next" }
export interface HelperRow { botId: string; name: string; threadId?: string; phrase: string; needsYou: boolean }
export interface SideJobCard { id: string; title: string; meta: string; glyph: StepGlyphKind; canStop: boolean; startedAt: number; lastActivityAt: number; doing?: string; finished: boolean }
export interface HelpingDog { botId: string; name: string; threadId?: string; state?: "queued" | "running" | "needsYou"; step?: LiveStep | null }

const GLYPHS: Partial<Record<OutcomeKind, StepGlyphKind>> = {
  command: "play", check: "play", cloud: "play", tool: "play", edit: "pencil", note: "pencil",
  read: "page", wrote: "page", delete: "page", search: "magnifier", chats: "magnifier", web: "magnifier", page: "magnifier", open: "magnifier",
  screen: "screen", computer: "screen", phone: "screen", help: "paw", team: "paw", dog: "paw",
};
const STEP_KINDS = new Set(["tool", "search"]);
const FINISHED = new Set(["done", "failed", "stopped"]);

export const outcomeOf = (activity: Pick<NativeActivity, "label">): OutcomeKind => outcomeKindOfTool(activity.label);
export const glyphOf = (outcome: OutcomeKind): StepGlyphKind => GLYPHS[outcome] ?? "play";

function ownActors(run: NativeRun): Set<string> | null {
  const parents = run.actors.filter(actor => actor.kind === "parent");
  const roots = (parents.length ? parents : run.actors.filter(actor => !actor.parentId)).map(actor => actor.id);
  return roots.length ? new Set(roots) : null;
}

export function stepRows(run: NativeRun | undefined, activities: readonly NativeActivity[], now: number): { rows: StepRow[]; trimmed: boolean } {
  if (!run) return { rows: [], trimmed: false };
  const own = ownActors(run);
  const step = liveStep(run);
  const rows: StepRow[] = [];
  if (step) {
    const age = ageWords(now - step.startedAt);
    rows.push({ id: step.id, runId: run.id, label: stepPhrase(step.kind, step.id), time: age ?? "now", glyph: "spinner", live: true, failed: false });
  }
  const finished = activities
    .filter(activity => STEP_KINDS.has(activity.kind) && FINISHED.has(activity.state) && activity.id !== step?.id && (!own || own.has(activity.actorId)))
    .filter(activity => outcomeOf(activity) !== "plan")
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const activity of finished) {
    const outcome = outcomeOf(activity);
    const failed = activity.state === "failed";
    rows.push({ id: activity.id, runId: run.id, label: stepLabel({ outcome, state: failed ? "failed" : "done", subject: activity.subject }), time: stepTime(activity.startedAt, now), glyph: activity.label.endsWith("cloud_job") ? "cloud" : glyphOf(outcome), live: false, failed });
  }
  return { rows, trimmed: Boolean(run.truncated) };
}

export function todoRows(plan: WirePlan | null | undefined, working: boolean): TodoRow[] {
  if (!plan?.items.length) return [];
  return plan.items.map(item => ({ text: item.text, mark: item.status === "done" ? "done" : item.status === "in_progress" ? (working ? "working" : "current") : "next" }));
}

export function helperRows(dogs: readonly HelpingDog[], now: number): HelperRow[] {
  return dogs.map(dog => {
    if (dog.state === "needsYou") return { botId: dog.botId, name: dog.name, threadId: dog.threadId, phrase: PANEL_WORDS.needsAnswer, needsYou: true };
    const step = dog.step;
    const phrase = step ? stepPhrase(step.kind, step.id) : stepPhrase("working", dog.botId);
    const age = step ? ageWords(now - step.startedAt) : null;
    return { botId: dog.botId, name: dog.name, threadId: dog.threadId, phrase: age ? `${phrase} · ${age}` : phrase, needsYou: false };
  });
}

const sideJobMeta = (startedAt: number, lastActivityAt: number, now: number) => {
  const going = goingWords(now - startedAt);
  return now - startedAt < 60_000 ? going : `${going} · last moved ${lastMovedWords(now - lastActivityAt)}`;
};
const timeOf = (iso: string | undefined) => { const at = iso ? Date.parse(iso) : NaN; return Number.isFinite(at) ? at : undefined; };
const sideActor = (actor: NativeActor) => actor.kind !== "parent" && (actor.background === true || actor.kind === "task");
const startOfToday = (now: number) => { const day = new Date(now); day.setHours(0, 0, 0, 0); return day.getTime(); };

export function sideJobCards(run: NativeRun | undefined, jobs: readonly CloudTaskSummary[], now: number): { running: SideJobCard[]; finished: SideJobCard[] } {
  const cards: SideJobCard[] = [];
  for (const job of jobs) {
    const startedAt = timeOf(job.startedAt) ?? timeOf(job.createdAt) ?? now;
    const lastActivityAt = timeOf(job.updatedAt) ?? startedAt;
    const finished = Boolean(job.finishedAt);
    cards.push({ id: `job:${job.id}`, title: job.title, meta: finished ? lastMovedLine(now - lastActivityAt) : sideJobMeta(startedAt, lastActivityAt, now), glyph: "cloud", canStop: !finished && job.stoppable, startedAt, lastActivityAt, finished, ...(job.stage ? { doing: job.stage } : {}) });
  }
  for (const actor of run?.actors ?? []) {
    if (!sideActor(actor)) continue;
    const lastActivityAt = actor.lastActivityAt ?? actor.startedAt;
    const finished = FINISHED.has(actor.state);
    const doing = actor.activity ?? actor.summary ?? actor.task;
    cards.push({ id: `actor:${actor.id}`, title: actor.label, meta: finished ? lastMovedLine(now - lastActivityAt) : sideJobMeta(actor.startedAt, lastActivityAt, now), glyph: actor.kind === "subagent" ? "paw" : "play", canStop: false, startedAt: actor.startedAt, lastActivityAt, finished, ...(doing ? { doing } : {}) });
  }
  const today = startOfToday(now);
  return {
    running: cards.filter(card => !card.finished).sort((a, b) => a.startedAt - b.startedAt),
    finished: cards.filter(card => card.finished && card.lastActivityAt >= today).sort((a, b) => b.lastActivityAt - a.lastActivityAt),
  };
}

const INPUT_LABELS: Partial<Record<OutcomeKind, LocaleKey>> = {
  command: "workPanel.input.ran", check: "workPanel.input.ran", cloud: "workPanel.input.ran",
  read: "workPanel.input.read", edit: "workPanel.input.changed", delete: "workPanel.input.changed", wrote: "workPanel.input.wrote",
  search: "workPanel.input.lookedFor", chats: "workPanel.input.lookedFor", web: "workPanel.input.lookedFor", page: "workPanel.input.lookedFor", open: "workPanel.input.lookedFor",
  help: "workPanel.input.asked", team: "workPanel.input.asked",
};

export function stepDetail(activity: NativeActivity): { title: string; inputLabel: string; outputLabel: string; input: string; output: string; shortened: boolean; hidden: boolean } {
  const outcome = outcomeOf(activity);
  const input = activity.input ?? "";
  const output = activity.output ?? activity.text ?? "";
  return {
    title: stepLabel({ outcome, state: activity.state === "failed" ? "failed" : "done", subject: activity.subject }),
    inputLabel: t(INPUT_LABELS[outcome] ?? "workPanel.input.sent"),
    outputLabel: PANEL_WORDS.cameBack,
    input, output,
    shortened: Boolean(activity.truncated),
    hidden: /«redacted|\[redacted/i.test(input + output),
  };
}

export function panelTitle(page: WorkPanelPage, botName: string, pushedTitle?: string, working = true): string {
  if (page.kind === "work") return t(page.runId || !working ? "workPanel.titleDid" : "workPanel.titleDoing", { name: botName });
  if (page.kind === "side-jobs") return PANEL_WORDS.sideJobs;
  return pushedTitle ?? "";
}
