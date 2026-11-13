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

export async function stopComputerJobs(jobs: ComputerJobs, threadId: string, deps: StopComputerJobsDeps): Promise<{ stopped: string[]; partly: string[]; left: string[] }> {
  const stopped: string[] = [];
  const partly: string[] = [];
  const left: string[] = [];
  for (const job of jobs.quiet(threadId)) {
    const release = jobs.hold(job.id);
    let result: RunStop = "alive";
    try {
      const computer = await deps.computer(job.botId);
      if (computer.state === "asleep") {
        left.push(job.id);
        continue;
      }
      if (computer.state === "running") result = await deps.stop(computer.box, job);
    } catch {
      result = "alive";
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
