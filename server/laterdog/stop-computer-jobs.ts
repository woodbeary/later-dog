import type { ComputerJob, ComputerJobs, JobComputer } from "./computer-jobs.ts";
import type { RunBox } from "./computer-runs.ts";

export interface StopComputerJobsDeps {
  computer(botId: string): Promise<JobComputer>;
  stop(box: RunBox, job: ComputerJob): Promise<boolean>;
  couldNotStop(threadId: string, job: ComputerJob): void;
}

export function couldNotStopLine(name: string): string {
  return `${name}'s command on its computer could not be stopped, so it is still running. Press Stop again to try once more.`;
}

export async function stopComputerJobs(jobs: ComputerJobs, threadId: string, deps: StopComputerJobsDeps): Promise<{ stopped: string[]; left: string[] }> {
  const stopped: string[] = [];
  const left: string[] = [];
  for (const job of jobs.quiet(threadId)) {
    const release = jobs.hold(job.id);
    let gone = false;
    try {
      const computer = await deps.computer(job.botId);
      gone = computer.state === "asleep" || (computer.state === "running" && await deps.stop(computer.box, job));
    } catch {
      gone = false;
    } finally {
      release();
    }
    if (gone) {
      jobs.ended(job.id);
      stopped.push(job.id);
    } else {
      left.push(job.id);
      deps.couldNotStop(threadId, job);
    }
  }
  return { stopped, left };
}
