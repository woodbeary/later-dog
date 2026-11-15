import { failedTurnTool, type FailedTurnTool } from "../../shared/failed-turn.ts";
import type { ComputerJob, ComputerJobs, JobComputer } from "./computer-jobs.ts";
import type { RunBox, RunStop } from "./computer-runs.ts";

export interface StopComputerJobsDeps {
  computer(botId: string): Promise<JobComputer>;
  stop(box: RunBox, job: ComputerJob): Promise<RunStop>;
  couldNotStop(threadId: string, job: ComputerJob): void;
  partlyStopped(threadId: string, job: ComputerJob): void;
}

export function partlyStoppedLine(name: string): string {
  return `${name}'s command on its computer was stopped, but part of it may still be running.`;
}

export function couldNotStopLine(name: string): string {
  return `${name}'s command on its computer could not be stopped, so it is still running. Press Stop again to try once more.`;
}

export type StopLineTool = FailedTurnTool & { pickup: "computer" };

export function couldNotStopTool(name: string): StopLineTool {
  return { ...failedTurnTool(couldNotStopLine(name), { written: true }), pickup: "computer" };
}

export function partlyStoppedTool(name: string): StopLineTool {
  return { ...failedTurnTool(partlyStoppedLine(name), { written: true }), pickup: "computer" };
}

export async function stopComputerJobs(jobs: ComputerJobs, threadId: string, deps: StopComputerJobsDeps): Promise<{ stopped: string[]; partly: string[]; left: string[] }> {
  const stopped: string[] = [];
  const partly: string[] = [];
  const left: string[] = [];
  for (const job of jobs.quiet(threadId)) {
    const release = jobs.hold(job.id);
    let result: RunStop = "alive";
    try {
      const computer = await deps.computer(job.botId).catch(() => null);
      if (computer?.state === "asleep") {
        left.push(job.id);
        continue;
      }
      if (computer?.state !== "running") result = "gone";
      else result = await deps.stop(computer.box, job).catch((): RunStop => "alive");
    } finally {
      release();
    }
    if (result === "gone") {
      jobs.ended(job.id);
      stopped.push(job.id);
    } else if (result === "partial") {
      jobs.ended(job.id);
      partly.push(job.id);
      deps.partlyStopped(threadId, job);
    } else {
      left.push(job.id);
      deps.couldNotStop(threadId, job);
    }
  }
  return { stopped, partly, left };
}

export interface JobStopHost {
  computer(botId: string): Promise<JobComputer>;
  stop(box: RunBox, job: ComputerJob): Promise<RunStop>;
  name(threadId: string): string;
  append(threadId: string, tool: StopLineTool): void;
  log(line: string): void;
}

export function createJobStop(jobs: ComputerJobs, host: JobStopHost): (threadId: string) => Promise<void> {
  return async (threadId) => {
    const result = await stopComputerJobs(jobs, threadId, {
      computer: host.computer,
      stop: host.stop,
      couldNotStop: (id) => host.append(id, couldNotStopTool(host.name(id))),
      partlyStopped: (id) => host.append(id, partlyStoppedTool(host.name(id))),
    });
    if (!result.stopped.length && !result.partly.length && !result.left.length) return;
    host.log(`stop ${threadId}: stopped ${result.stopped.join(", ") || "none"}, partly ${result.partly.join(", ") || "none"}, left ${result.left.join(", ") || "none"}`);
  };
}
