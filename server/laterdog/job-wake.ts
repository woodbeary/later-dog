import { failedTurnTool } from "../../shared/failed-turn.ts";
import type { WireMessage } from "../../shared/wire.ts";
import type { ComputerJobs, EndedComputerJob } from "./computer-jobs.ts";

type NewMessage = Omit<WireMessage, "id" | "at">;

const ENDED_WORDS: Record<EndedComputerJob["end"]["how"], string> = { finished: "finished", failed: "failed", stopped: "was stopped" };

export function jobWakeLine(name: string, jobs: readonly EndedComputerJob[]): string {
  if (jobs.length === 1) return `${name}'s command ${ENDED_WORDS[jobs[0]!.end.how]}, so it is carrying on.`;
  return `${name}'s ${jobs.length} commands ended, so it is carrying on.`;
}

function endedHow(job: EndedComputerJob): string {
  const { how, exitCode } = job.end;
  if (how === "stopped") return "was stopped before it could finish";
  return `${how === "finished" ? "finished" : "failed"} with exit code ${exitCode}`;
}

export function jobWakeFailedLine(name: string): string {
  return `${name} could not carry on after its command ended. Send a message to carry on.`;
}

export function jobWakePrompt(jobs: readonly EndedComputerJob[]): string {
  const lines = jobs.map((job) => `- \`${job.command.slice(0, 200)}\` ${endedHow(job)}. Read its result with run_on_computer and run_id "${job.id}".`);
  return `[A command you started on your cloud computer ended after your turn did. This note is from later.dog, not typed by the person.\n${lines.join("\n")}\nRead the result, then carry on with the person's request and finish with one clear answer.]`;
}

export interface JobWakeHost {
  dog(threadId: string): { botId: string; name: string } | null;
  free(botId: string, threadId: string): boolean;
  request(threadId: string): string | undefined;
  append(threadId: string, message: NewMessage): WireMessage;
  start(botId: string, threadId: string, prompt: string, requestMessageId: string): Promise<unknown>;
  blocked(error: unknown): boolean;
  log?(line: string): void;
}

export function createJobWake(jobs: ComputerJobs, host: JobWakeHost) {
  const starting = new Set<string>();
  const shown = new Set<string>();
  const log = host.log ?? (() => {});
  return {
    deliver(): string[] {
      const byThread = new Map<string, EndedComputerJob[]>();
      for (const job of jobs.unannounced()) byThread.set(job.threadId, [...(byThread.get(job.threadId) ?? []), job]);
      const woken: string[] = [];
      for (const [threadId, ended] of byThread) {
        if (starting.has(threadId)) continue;
        const dog = host.dog(threadId);
        if (!dog) {
          jobs.announced(ended.map((job) => job.id));
          log(`job wake: ${threadId} is not a dog's own chat; not woken`);
          continue;
        }
        if (!host.free(dog.botId, threadId)) continue;
        const request = host.request(threadId);
        jobs.announced(ended.map((job) => job.id));
        const fresh = ended.some((job) => !shown.has(job.id));
        const line = fresh ? host.append(threadId, { role: "bot", kind: "activity", tool: { name: `recovery: ${jobWakeLine(dog.name, ended)}`, ok: true, pickup: "computer" } }) : undefined;
        for (const job of ended) shown.add(job.id);
        starting.add(threadId);
        woken.push(threadId);
        log(`job wake: ${threadId} carrying on after ${ended.map((job) => job.id).join(", ")}`);
        void host.start(dog.botId, threadId, jobWakePrompt(ended), request ?? line?.id ?? "").catch((error: unknown) => {
          if (host.blocked(error)) {
            jobs.restore(ended);
            log(`job wake: ${threadId} waits for a free slot`);
            return;
          }
          host.append(threadId, { role: "bot", kind: "activity", tool: { ...failedTurnTool(jobWakeFailedLine(dog.name)), pickup: "computer" } });
          log(`job wake: ${threadId} could not carry on: ${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => starting.delete(threadId));
      }
      return woken;
    },
  };
}
