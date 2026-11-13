import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import { MAX_RUN_MS, type RunBox } from "./computer-runs.ts";

const jobSchema = z.object({
  id: z.string(), botId: z.string(), threadId: z.string(), command: z.string(), startedAt: z.number(),
});
export type ComputerJob = z.infer<typeof jobSchema>;

export const JOB_CHECK_MS = 30_000;
export const JOB_GRACE_MS = 10 * 60_000;

export interface ComputerJobProbe {
  box(botId: string): Promise<RunBox | null>;
  done(box: RunBox, job: ComputerJob): Promise<boolean>;
}

export interface ComputerJobLedger {
  started(job: ComputerJob): void;
  hold(id: string): () => void;
  ended(id: string): void;
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

  has(id: string): boolean {
    return this.#jobs.has(id);
  }

  live(threadId: string): ComputerJob[] {
    return [...this.#jobs.values()].filter((job) => job.threadId === threadId);
  }

  count(threadId: string): number {
    return this.live(threadId).length;
  }

  async check(probe: ComputerJobProbe): Promise<string[]> {
    if (this.#checking) return [];
    this.#checking = true;
    try { return await this.#check(probe); } finally { this.#checking = false; }
  }

  async #check(probe: ComputerJobProbe): Promise<string[]> {
    const ended: string[] = [];
    for (const job of this.#jobs.values()) {
      if (this.#held.has(job.id)) continue;
      if (this.#now() - job.startedAt >= MAX_RUN_MS + JOB_GRACE_MS) {
        ended.push(job.id);
        continue;
      }
      try {
        const box = await probe.box(job.botId);
        if (!box || await probe.done(box, job)) ended.push(job.id);
      } catch {}
    }
    for (const id of ended) if (!this.#held.has(id)) this.ended(id);
    return ended;
  }

  #save(): void {
    if (!this.#file) return;
    try { writeFileAtomic(this.#file, JSON.stringify([...this.#jobs.values()])); } catch {}
  }
}
