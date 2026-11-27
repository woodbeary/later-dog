import { stat } from "node:fs/promises";

export const MOUNTED_FOLDER_ANSWER_MS = 5_000;
export const MOUNTED_FOLDER_STALL_RECHECK_MS = 15_000;

export class MountedFolderStalled extends Error {
  readonly code = "ETIMEDOUT";
  readonly path: string;
  constructor(path: string) {
    super("The working folder did not answer in time: " + path);
    this.path = path;
  }
}

type Probe = (path: string) => Promise<unknown>;
export type FolderWait = { waiting: true } | { waiting: false; opened: boolean; waitedMs: number };

export interface MountedFolderGateOptions {
  probe?: Probe;
  answerMs?: number;
  recheckMs?: number;
  now?: () => number;
  active?: () => boolean;
}

export function mountedFoldersActive(): boolean {
  return process.env.LATERDOG_CLOUD_ROLE === "home" && Boolean(process.env.LATERDOG_WORK_FOLDER_LAYOUT);
}

export function createMountedFolderGate(options: MountedFolderGateOptions = {}) {
  const probe = options.probe ?? ((path: string) => stat(path));
  const answerMs = options.answerMs ?? MOUNTED_FOLDER_ANSWER_MS;
  const recheckMs = options.recheckMs ?? MOUNTED_FOLDER_STALL_RECHECK_MS;
  const now = options.now ?? Date.now;
  const active = options.active ?? mountedFoldersActive;
  const inFlight = new Map<string, Promise<void>>();
  const stalledAt = new Map<string, number>();

  function start(path: string): Promise<void> {
    const running = inFlight.get(path);
    if (running) return running;
    const settled = probe(path).then(() => undefined, () => undefined).finally(() => {
      inFlight.delete(path);
      stalledAt.delete(path);
    });
    inFlight.set(path, settled);
    return settled;
  }

  async function answers(path: string): Promise<boolean> {
    if (!active()) return true;
    const stalled = stalledAt.get(path);
    if (stalled !== undefined && inFlight.has(path) && now() - stalled < recheckMs) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), answerMs); });
    const answered = await Promise.race([start(path).then(() => true as const), late]);
    if (timer) clearTimeout(timer);
    if (!answered) stalledAt.set(path, now());
    return answered;
  }

  async function require(path: string): Promise<void> {
    if (!(await answers(path))) throw new MountedFolderStalled(path);
  }

  async function wait(path: string, budgetMs: number, onWait?: (wait: FolderWait) => void): Promise<void> {
    if (!active()) return;
    const began = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let announced = false;
    const notice = setTimeout(() => { announced = true; onWait?.({ waiting: true }); }, answerMs);
    const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), budgetMs); });
    const answered = await Promise.race([start(path).then(() => true as const), late]);
    clearTimeout(timer);
    clearTimeout(notice);
    if (announced) onWait?.({ waiting: false, opened: answered, waitedMs: Math.max(0, now() - began) });
    if (!answered) {
      stalledAt.set(path, now());
      throw new MountedFolderStalled(path);
    }
  }

  return { answers, require, wait, stalledPaths: () => [...stalledAt.keys()] };
}

export const mountedFolderGate = createMountedFolderGate();
