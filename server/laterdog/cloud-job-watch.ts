import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import { ACTIVE_STATES } from "../../shared/laterdog.ts";
import { desktopSupervisorToken, supervisorConnection } from "./config.ts";

const HOUR_MS = 60 * 60_000;

export const CLOUD_JOB_UNCONFIRMED_MS = 3 * HOUR_MS;
export const CLOUD_JOB_WATCH_MS = 12 * HOUR_MS;
export const CLOUD_JOB_ASK_EVERY_MS = 60_000;
export const CLOUD_JOBS_WATCHED_MAX = 100;
const ASK_TIMEOUT_MS = 10_000;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_FLIGHT = new Set<string>(["queued", ...ACTIVE_STATES.filter((state) => state !== "submission_unknown")]);

export function cloudJobInFlight(state: string): boolean {
  return IN_FLIGHT.has(state);
}

interface WatchedJob {
  id: string;
  since: number;
  seen: number;
}

export type CloudJobStates = (ids: string[]) => Promise<Map<string, string> | null>;

export interface CloudJobWatch {
  watch(jobId: string): void;
  inFlight(): boolean;
  refresh(): Promise<void>;
}

function watchedJobs(file: string): WatchedJob[] {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { jobs?: unknown };
    if (!Array.isArray(value.jobs)) return [];
    return value.jobs
      .filter((job): job is WatchedJob => Boolean(job) && typeof job === "object" && typeof job.id === "string" && JOB_ID.test(job.id) && Number.isSafeInteger(job.since) && Number.isSafeInteger(job.seen))
      .map(({ id, since, seen }) => ({ id, since, seen }))
      .slice(-CLOUD_JOBS_WATCHED_MAX);
  } catch {
    return [];
  }
}

export function createCloudJobWatch(options: { file: string; states: CloudJobStates; now?: () => number; log?: (line: string) => void }): CloudJobWatch {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  let jobs = watchedJobs(options.file);
  let askedAt = 0;
  let asking: Promise<void> | null = null;

  const save = () => {
    try {
      mkdirSync(dirname(options.file), { recursive: true });
      writeFileAtomic(options.file, JSON.stringify({ jobs }), { mode: 0o600 });
    } catch (error) {
      log(`cloud home: could not save the cloud jobs it waits for: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const prune = () => {
    const at = now();
    const kept = jobs.filter((job) => at - job.since < CLOUD_JOB_WATCH_MS && at - job.seen < CLOUD_JOB_UNCONFIRMED_MS);
    if (kept.length === jobs.length) return;
    jobs = kept;
    save();
  };

  const ask = async (ids: string[]) => {
    const states = await options.states(ids).catch(() => null);
    if (!states) return;
    const asked = new Set(ids);
    const at = now();
    jobs = jobs.flatMap((job) => {
      if (!asked.has(job.id)) return [job];
      const state = states.get(job.id);
      return state !== undefined && cloudJobInFlight(state) ? [{ ...job, seen: at }] : [];
    });
    save();
  };

  const refresh = (): Promise<void> => {
    if (asking) return asking;
    prune();
    if (!jobs.length) return Promise.resolve();
    askedAt = now();
    asking = ask(jobs.map((job) => job.id)).finally(() => {
      asking = null;
    });
    return asking;
  };

  return {
    watch(jobId) {
      if (!JOB_ID.test(jobId) || jobs.some((job) => job.id === jobId)) return;
      const at = now();
      jobs = [...jobs, { id: jobId, since: at, seen: at }].slice(-CLOUD_JOBS_WATCHED_MAX);
      save();
    },
    inFlight() {
      prune();
      if (jobs.length && now() - askedAt >= CLOUD_JOB_ASK_EVERY_MS) void refresh();
      return jobs.length > 0;
    },
    refresh,
  };
}

export function supervisorJobStates(fetcher: typeof fetch = fetch): CloudJobStates {
  return async (ids) => {
    try {
      const { origin } = supervisorConnection();
      const response = await fetcher(`${origin}/v1/jobs?ids=${ids.join(",")}`, {
        redirect: "error",
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
        headers: { authorization: `Bearer ${desktopSupervisorToken()}` },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { jobs?: unknown };
      if (!Array.isArray(body.jobs)) return null;
      return new Map(body.jobs.flatMap((job): Array<[string, string]> =>
        job && typeof job === "object" && typeof job.id === "string" && typeof job.state === "string" ? [[job.id, job.state]] : []));
    } catch {
      return null;
    }
  };
}
