import { readFileSync, renameSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import type { RunBox, RunLiveness } from "./computer-runs.ts";

const endSchema = z.object({ how: z.enum(["finished", "failed", "stopped", "lost"]), exitCode: z.number().int().optional(), at: z.number() });
const jobSchema = z.object({
  id: z.string(), botId: z.string(), threadId: z.string(), command: z.string(), startedAt: z.number(),
  end: endSchema.optional(),
  quiet: z.boolean().optional(),
});
export type ComputerJob = z.infer<typeof jobSchema>;
export type ComputerJobEnd = z.infer<typeof endSchema>;
export type EndedComputerJob = ComputerJob & { end: ComputerJobEnd };

export const JOB_CHECK_MS = 30_000;
export type JobComputer = { state: "running"; box: RunBox } | { state: "asleep" | "gone" | "unsure" };

export interface ComputerJobProbe {
  computer(botId: string): Promise<JobComputer>;
  exit(box: RunBox, job: ComputerJob): Promise<{ exitCode: number; at?: number } | null>;
  liveness(box: RunBox, job: ComputerJob): Promise<RunLiveness>;
}

type Sighting = "asleep" | "gone" | "dead";

export interface ComputerJobLedger {
  started(job: ComputerJob): void;
  hold(id: string): () => void;
  ended(id: string): void;
}

export function jobEnd(exitCode: number | null, at: number): ComputerJobEnd {
  if (exitCode === null || !Number.isInteger(exitCode)) return { how: "stopped", at };
  return { how: exitCode === 0 ? "finished" : "failed", exitCode, at };
}

export interface ComputerJobsOptions {
  now?: () => number;
  changed?: (threadId: string) => void;
  log?: (line: string) => void;
}

export class ComputerJobs implements ComputerJobLedger {
  readonly #file: string | null;
  readonly #now: () => number;
  readonly #changed: (threadId: string) => void;
  readonly #jobs = new Map<string, ComputerJob>();
  readonly #held = new Map<string, number>();
  #checking = false;
  readonly #seen = new Map<string, Sighting>();

  constructor(file: string | null, options: ComputerJobsOptions = {}) {
    this.#file = file;
    this.#now = options.now ?? Date.now;
    this.#changed = options.changed ?? (() => {});
    if (!file) return;
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { return; }
    try {
      for (const job of z.array(jobSchema).parse(JSON.parse(raw))) this.#jobs.set(job.id, job);
    } catch (error) {
      const aside = `${file}.corrupt-${this.#now()}`;
      try { renameSync(file, aside); } catch {}
      (options.log ?? console.warn)(`computer jobs: ${file} was unreadable (${error instanceof Error ? error.message.slice(0, 200) : String(error)}); moved it to ${aside} and started empty`);
    }
  }

  started(job: ComputerJob): void {
    this.#jobs.set(job.id, job);
    this.#save();
    this.#changed(job.threadId);
  }

  hold(id: string): () => void {
    this.#held.set(id, (this.#held.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#held.get(id) ?? 1) - 1;
      if (left > 0) this.#held.set(id, left);
      else this.#held.delete(id);
    };
  }

  ended(id: string): void {
    const job = this.#jobs.get(id);
    if (!job) return;
    this.#jobs.delete(id);
    this.#save();
    this.#changed(job.threadId);
  }

  finished(id: string, end: ComputerJobEnd): void {
    const job = this.#jobs.get(id);
    if (!job || job.end) return;
    if (job.quiet) this.#jobs.delete(id);
    else this.#jobs.set(id, { ...job, end });
    this.#save();
    this.#changed(job.threadId);
  }

  quiet(threadId: string): ComputerJob[] {
    const all = [...this.#jobs.values()].filter((job) => job.threadId === threadId);
    if (!all.length) return [];
    for (const job of all) {
      if (job.end) this.#jobs.delete(job.id);
      else this.#jobs.set(job.id, { ...job, quiet: true });
    }
    this.#save();
    this.#changed(threadId);
    return all.filter((job) => !job.end);
  }

  has(id: string): boolean {
    return this.#jobs.has(id);
  }

  live(threadId: string): ComputerJob[] {
    return [...this.#jobs.values()].filter((job) => job.threadId === threadId && !job.end);
  }

  count(threadId: string): number {
    return this.live(threadId).length;
  }

  unannounced(): EndedComputerJob[] {
    return [...this.#jobs.values()].filter((job): job is EndedComputerJob => Boolean(job.end));
  }

  announced(ids: readonly string[]): void {
    const threads = new Set<string>();
    for (const id of ids) {
      const job = this.#jobs.get(id);
      if (!job?.end) continue;
      this.#jobs.delete(id);
      threads.add(job.threadId);
    }
    if (!threads.size) return;
    this.#save();
    for (const threadId of threads) this.#changed(threadId);
  }

  async check(probe: ComputerJobProbe): Promise<string[]> {
    if (this.#checking) return [];
    this.#checking = true;
    try { return await this.#check(probe); } finally { this.#checking = false; }
  }

  async #check(probe: ComputerJobProbe): Promise<string[]> {
    const ends = new Map<string, ComputerJobEnd>();
    for (const job of this.#jobs.values()) {
      if (job.end || this.#held.has(job.id)) continue;
      const before = this.#seen.get(job.id);
      this.#seen.delete(job.id);
      let sighting: Sighting | undefined;
      try {
        const computer = await probe.computer(job.botId);
        if (computer.state === "asleep" || computer.state === "gone") sighting = computer.state;
        if (computer.state === "running") {
          const exit = await probe.exit(computer.box, job);
          if (exit && Number.isInteger(exit.exitCode)) {
            ends.set(job.id, jobEnd(exit.exitCode, exit.at !== undefined && Number.isFinite(exit.at) ? Math.min(exit.at, this.#now()) : this.#now()));
            continue;
          }
          if (await probe.liveness(computer.box, job) === "dead") sighting = "dead";
        }
      } catch {
        sighting = undefined;
      }
      if (!sighting) continue;
      if (before !== sighting) { this.#seen.set(job.id, sighting); continue; }
      ends.set(job.id, sighting === "dead" ? { how: "lost", at: this.#now() } : jobEnd(null, this.#now()));
    }
    for (const [id, end] of ends) if (!this.#held.has(id)) this.finished(id, end);
    for (const id of this.#seen.keys()) if (!this.#jobs.has(id)) this.#seen.delete(id);
    return [...ends.keys()];
  }

  #save(): void {
    if (!this.#file) return;
    try { writeFileAtomic(this.#file, JSON.stringify([...this.#jobs.values()])); } catch {}
  }
}
