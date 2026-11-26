import type { NativeRun } from "../../shared/native-runs";
import type { WorkState } from "../../shared/work-state";
import { ageWords, helpersLine, liveStep, sideJobsWords, stepPhrase, type LiveStep } from "../../shared/step-words";
import { t } from "./i18n";
import type { LocaleKey } from "@/locales";

export type WorkLine =
  | { kind: "step"; stepId: string; phrase: string; age: string | null; sideJobs: string | null }
  | { kind: "helpers"; text: string; needsYou: boolean; open?: string }
  | { kind: "waiting"; text: string };

export interface WorkLineInput {
  working: boolean;
  run?: NativeRun;
  step?: LiveStep | null;
  work?: WorkState;
  sideJobs: number;
  now: number;
}

const WAITING: Partial<Record<WorkState["kind"], LocaleKey>> = {
  "waiting-for-usage": "workLine.usage",
  "waiting-for-computer": "workLine.computer",
  "waiting-for-files": "workLine.files",
  retrying: "workLine.retrying",
};

export function sideJobCount(run: NativeRun | undefined, work: WorkState | undefined): number {
  const actors = run?.actors.filter(actor => actor.kind !== "parent" && actor.background && actor.state === "running").length ?? 0;
  return actors + (work?.kind === "running" ? work.computerBackground ?? 0 : 0);
}

function heldBySideJobs(run: NativeRun | undefined, sideJobs: number): boolean {
  if (!run || sideJobs <= 0 || run.currentActivity) return false;
  return run.actors.find(actor => actor.kind === "parent")?.state === "waiting";
}

export function workLine({ working, run, step, work, sideJobs, now }: WorkLineInput): WorkLine | null {
  if (work?.kind === "waiting-on-dog") {
    const helpers = helpersLine(work.dogs.map(dog => ({ name: dog.name, state: dog.ask ? "needsYou" as const : "running" as const })));
    if (!helpers) return null;
    const asking = work.dogs.find(dog => dog.ask);
    return helpers.needsYou && asking ? { kind: "helpers", text: helpers.text, needsYou: true, open: asking.id } : { kind: "helpers", text: helpers.text, needsYou: false };
  }
  const waiting = work ? WAITING[work.kind] : undefined;
  if (waiting) return { kind: "waiting", text: t(waiting) };
  if (!working || (work && work.kind !== "running")) return null;
  if (heldBySideJobs(run, sideJobs)) return { kind: "waiting", text: t("workLine.sideJobs", { sideJobs: sideJobsWords(sideJobs) }) };
  const current = liveStep(run) ?? step ?? null;
  if (!current) return null;
  return {
    kind: "step",
    stepId: current.id,
    phrase: stepPhrase(current.kind, current.id),
    age: ageWords(now - current.startedAt),
    sideJobs: sideJobs > 0 ? sideJobsWords(sideJobs) : null,
  };
}
