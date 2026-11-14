import { failedTurnTool } from "../../shared/failed-turn.ts";
import type { WireMessage } from "../../shared/wire.ts";
import type { ComputerJobs, EndedComputerJob } from "./computer-jobs.ts";
import { MAX_RUN_MS } from "./computer-runs.ts";

type NewMessage = Omit<WireMessage, "id" | "at">;

export const WAKES_PER_MESSAGE = 2;
export const WAKE_FRESH_MS = 30 * 60_000;

const ENDED_WORDS: Record<EndedComputerJob["end"]["how"], string> = { finished: "finished", failed: "failed", stopped: "was stopped", lost: "ended without a result" };

function endedPhrase(name: string, jobs: readonly EndedComputerJob[]): string {
  return jobs.length === 1 ? `${name}'s command ${ENDED_WORDS[jobs[0]!.end.how]}` : `${name}'s ${jobs.length} commands ended`;
}

export function jobWakeLine(name: string, jobs: readonly EndedComputerJob[]): string {
  return `${endedPhrase(name, jobs)}, so it is carrying on.`;
}

export function jobNotWokenLine(name: string, jobs: readonly EndedComputerJob[]): string {
  return `${endedPhrase(name, jobs)}. ${name} was not woken for it.`;
}

export function jobLostLine(name: string, jobs: readonly EndedComputerJob[]): string {
  return jobs.length === 1 ? `${name}'s command on its computer ended without a result.` : `${name}'s ${jobs.length} commands on its computer ended without a result.`;
}

export function jobWakeFailedLine(name: string): string {
  return `${name} could not carry on after its command ended. Send a message to carry on.`;
}

function endedHow(job: EndedComputerJob): string {
  const { how, exitCode } = job.end;
  if (how === "stopped") return "was stopped before it could finish (its computer went to sleep or was removed)";
  return `${how === "finished" ? "finished" : "failed"} with exit code ${exitCode}`;
}

export function jobWakePrompt(jobs: readonly EndedComputerJob[]): string {
  const lines = jobs.map((job) => `- \`${job.command.slice(0, 200)}\` ${endedHow(job)}. Read its result with run_on_computer and run_id "${job.id}".`);
  return `[A command you started on your cloud computer ended after your turn did. This note is from later.dog, not typed by the person.\n${lines.join("\n")}\nRead the result, then carry on with the person's request and finish with one clear answer.]`;
}

export function fromPerson(message: WireMessage): boolean {
  return message.role === "user" && message.kind === "text" && !message.from && !message.peerAsk && !message.peerPost && !message.comm
    && !message.roomRequest && !message.handoffId && !message.webhookPost && !message.ownersRoutine && !message.routineRun;
}

export function wakesSincePerson(path: readonly WireMessage[]): number {
  let count = 0;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const message = path[index]!;
    if (fromPerson(message)) break;
    if (message.tool?.pickup === "computer" && message.tool.ok === true && message.tool.name.startsWith("recovery:")) count += 1;
  }
  return count;
}

export type NotWoken = "lost" | "stale" | "long" | "handoff" | "bound";

export function whyNotWoken(job: EndedComputerJob, now: number): NotWoken | null {
  if (job.end.how === "lost") return "lost";
  if (now - job.end.at > WAKE_FRESH_MS) return "stale";
  if (job.end.at - job.startedAt > MAX_RUN_MS) return "long";
  return null;
}

export interface JobWakeHost {
  dog(threadId: string): { botId: string; name: string } | null;
  free(botId: string, threadId: string): boolean;
  path(threadId: string): readonly WireMessage[];
  handoffDone(threadId: string): boolean;
  request(threadId: string): string | undefined;
  append(threadId: string, message: NewMessage): WireMessage;
  start(botId: string, threadId: string, prompt: string, requestMessageId: string): Promise<unknown>;
  blocked(error: unknown): boolean;
  now?(): number;
  log?(line: string): void;
}

export function createJobWake(jobs: ComputerJobs, host: JobWakeHost) {
  const starting = new Set<string>();
  const log = host.log ?? (() => {});
  const now = host.now ?? Date.now;

  const notWoken = (threadId: string, name: string, ended: readonly EndedComputerJob[], why: NotWoken) => {
    jobs.announced(ended.map((job) => job.id));
    host.append(threadId, { role: "bot", kind: "activity", tool: { name: why === "lost" ? jobLostLine(name, ended) : jobNotWokenLine(name, ended), ok: true, pickup: "computer" } });
    log(`job wake: ${threadId} not woken (${why}) for ${ended.map((job) => job.id).join(", ")}`);
  };

  return {
    deliver(): string[] {
      const byThread = new Map<string, EndedComputerJob[]>();
      for (const job of jobs.unannounced()) byThread.set(job.threadId, [...(byThread.get(job.threadId) ?? []), job]);
      const woken: string[] = [];
      for (const [threadId, all] of byThread) {
        if (starting.has(threadId)) continue;
        const dog = host.dog(threadId);
        if (!dog) {
          jobs.announced(all.map((job) => job.id));
          log(`job wake: ${threadId} is not a dog's own chat; not woken`);
          continue;
        }
        const at = now();
        const kept: EndedComputerJob[] = [];
        for (const why of ["lost", "stale", "long"] as const) {
          const out = all.filter((job) => whyNotWoken(job, at) === why);
          if (out.length) notWoken(threadId, dog.name, out, why);
        }
        for (const job of all) if (whyNotWoken(job, at) === null) kept.push(job);
        if (!kept.length) continue;
        if (host.handoffDone(threadId)) { notWoken(threadId, dog.name, kept, "handoff"); continue; }
        if (!host.free(dog.botId, threadId)) continue;
        if (wakesSincePerson(host.path(threadId)) >= WAKES_PER_MESSAGE) { notWoken(threadId, dog.name, kept, "bound"); continue; }
        const request = host.request(threadId);
        starting.add(threadId);
        woken.push(threadId);
        log(`job wake: ${threadId} carrying on after ${kept.map((job) => job.id).join(", ")}`);
        void host.start(dog.botId, threadId, jobWakePrompt(kept), request ?? "").then(() => {
          jobs.announced(kept.map((job) => job.id));
          host.append(threadId, { role: "bot", kind: "activity", tool: { name: `recovery: ${jobWakeLine(dog.name, kept)}`, ok: true, pickup: "computer" } });
        }, (error: unknown) => {
          if (host.blocked(error)) {
            log(`job wake: ${threadId} waits for a free slot`);
            return;
          }
          jobs.announced(kept.map((job) => job.id));
          host.append(threadId, { role: "bot", kind: "activity", tool: { ...failedTurnTool(jobWakeFailedLine(dog.name)), pickup: "computer" } });
          log(`job wake: ${threadId} could not carry on: ${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => starting.delete(threadId));
      }
      return woken;
    },
  };
}
