import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import { MAX_RUN_MS, type RunBox } from "./computer-runs.ts";

const endSchema = z.object({ how: z.enum(["finished", "failed", "stopped"]), exitCode: z.number().int().optional(), at: z.number() });
const jobSchema = z.object({
  id: z.string(), botId: z.string(), threadId: z.string(), command: z.string(), startedAt: z.number(),
  end: endSchema.optional(),
});
export type ComputerJob = z.infer<typeof jobSchema>;
export type ComputerJobEnd = z.infer<typeof endSchema>;
export type EndedComputerJob = ComputerJob & { end: ComputerJobEnd };

export const JOB_CHECK_MS = 30_000;
export const JOB_GRACE_MS = 10 * 60_000;

export interface ComputerJobProbe {
  box(botId: string): Promise<RunBox | null>;
  outcome(box: RunBox, job: ComputerJob): Promise<{ exitCode: number | null } | null>;
}

export interface ComputerJobLedger {
  started(job: ComputerJob): void;
  hold(id: string): () => void;
  ended(id: string): void;
}

export function jobEnd(exitCode: number | null, at: number): ComputerJobEnd {
  if (exitCode === null || !Number.isInteger(exitCode)) return { how: "stopped", at };
  return { how: exitCode === 0 ? "finished" : "failed", exitCode, at };
}

export class ComputerJobs implements ComputerJobLedger {
  readonly #file: string | null;
  readonly #now: () => number;
  readonly #changed: (threadId: string) => void;
  readonly #jobs = new Map<string, ComputerJob>();
  readonly #held = new Map<string, number>();
  #checking = false;

  constructor(file: string | null, options: { now?: () => number; changed?: (threadId: string) => void } = {}) {
    this.#file = file;
    this.#now = options.now ?? Date.now;
    this.#changed = options.changed ?? (() => {});
    if (!file) return;
    try {
      for (const job of z.array(jobSchema).parse(JSON.parse(readFileSync(file, "utf8")))) this.#jobs.set(job.id, job);
    } catch {}
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
    this.#jobs.set(id, { ...job, end });
    this.#save();
    this.#changed(job.threadId);
  }

  quiet(threadId: string): ComputerJob[] {
    const all = [...this.#jobs.values()].filter((job) => job.threadId === threadId);
    if (!all.length) return [];
    for (const job of all) this.#jobs.delete(job.id);
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

  restore(jobs: readonly EndedComputerJob[]): void {
    for (const job of jobs) if (!this.#jobs.has(job.id)) this.#jobs.set(job.id, job);
    this.#save();
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
      if (this.#now() - job.startedAt >= MAX_RUN_MS + JOB_GRACE_MS) {
        ends.set(job.id, jobEnd(null, this.#now()));
        continue;
      }
      try {
        const box = await probe.box(job.botId);
        const outcome = box ? await probe.outcome(box, job) : { exitCode: null };
        if (outcome) ends.set(job.id, jobEnd(outcome.exitCode, this.#now()));
      } catch {}
    }
    for (const [id, end] of ends) if (!this.#held.has(id)) this.finished(id, end);
    return [...ends.keys()];
  }

  #save(): void {
    if (!this.#file) return;
    try { writeFileAtomic(this.#file, JSON.stringify([...this.#jobs.values()])); } catch {}
  }
}
