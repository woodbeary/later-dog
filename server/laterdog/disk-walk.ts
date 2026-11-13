import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { setPriority } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface WalkRoot {
  key: string;
  paths: string[];
  split?: boolean;
  skip?: string[];
  limitMs?: number;
}

export interface WalkJob {
  roots: WalkRoot[];
  rootLimitMs: number;
  totalLimitMs: number;
  generatedNames: string[];
  pauseEvery?: number;
  pauseMs?: number;
  sharedLimit?: number;
}

export interface WalkResult {
  key: string;
  bytes: number;
  generated?: number;
  history?: number;
  atLeast?: true;
}

type Kind = "files" | "generated" | "history";

interface Pending {
  path: string;
  kind: Kind;
  dev: number;
}

export interface WalkState {
  clock: () => number;
  pause: () => void;
  pauseEvery: number;
  generated: ReadonlySet<string>;
  shared: Set<number>;
  sharedLimit: number;
  seen: number;
}

const SCRATCH_PARENT = ".wrangler";
const SCRATCH_CHILD = "tmp";
const HISTORY = ".git";

function sleeper(ms: number): () => void {
  if (ms <= 0) return () => {};
  const cell = new Int32Array(new SharedArrayBuffer(4));
  return () => { Atomics.wait(cell, 0, 0, ms); };
}

export function walkState(job: Pick<WalkJob, "generatedNames" | "pauseEvery" | "pauseMs" | "sharedLimit">, clock: () => number = Date.now): WalkState {
  return {
    clock,
    pause: sleeper(job.pauseMs ?? 0),
    pauseEvery: Math.max(1, job.pauseEvery ?? 2000),
    generated: new Set(job.generatedNames),
    shared: new Set(),
    sharedLimit: job.sharedLimit ?? 1_000_000,
    seen: 0,
  };
}

function kindIn(parent: Pending, name: string, state: WalkState, split: boolean): Kind {
  if (parent.kind !== "files" || !split) return parent.kind;
  if (state.generated.has(name)) return "generated";
  if (name === SCRATCH_CHILD && basename(parent.path) === SCRATCH_PARENT) return "generated";
  if (name === HISTORY) return "history";
  return "files";
}

export function walkTree(root: WalkRoot, deadline: number, state: WalkState): WalkResult {
  const totals: Record<Kind, number> = { files: 0, generated: 0, history: 0 };
  const skip = new Set(root.skip ?? []);
  const pending: Pending[] = [];
  let atLeast = false;
  let stopped = false;
  const count = (path: string, kind: Kind, dev: number | null) => {
    let info;
    try { info = lstatSync(path); } catch { return; }
    if (dev !== null && info.dev !== dev) return;
    if (skip.has(path)) return;
    if (!info.isDirectory() && info.nlink > 1) {
      if (state.shared.has(info.ino)) return;
      if (state.shared.size < state.sharedLimit) state.shared.add(info.ino);
    }
    totals[kind] += info.blocks * 512;
    if (info.isDirectory()) pending.push({ path, kind, dev: info.dev });
  };
  for (const path of root.paths) count(path, "files", null);
  while (pending.length) {
    if (state.clock() >= deadline) { stopped = true; break; }
    const dir = pending.pop()!;
    let names: string[];
    try { names = readdirSync(dir.path); } catch { atLeast = true; continue; }
    for (const name of names) {
      count(join(dir.path, name), kindIn(dir, name, state, Boolean(root.split)), dir.dev);
      state.seen++;
      if (state.seen % state.pauseEvery === 0) {
        state.pause();
        if (state.clock() >= deadline) { stopped = true; break; }
      }
    }
    if (stopped) break;
  }
  const bytes = totals.files + totals.generated + totals.history;
  return {
    key: root.key,
    bytes,
    ...(root.split ? { generated: totals.generated, history: totals.history } : {}),
    ...(atLeast || stopped ? { atLeast: true as const } : {}),
  };
}

export function runJob(job: WalkJob, write: (result: WalkResult) => void, clock: () => number = Date.now): void {
  const state = walkState(job, clock);
  const end = clock() + job.totalLimitMs;
  for (const root of job.roots) {
    const deadline = Math.min(end, clock() + (root.limitMs ?? job.rootLimitMs));
    write(walkTree(root, deadline, state));
  }
}

function yieldTheDisk(): void {
  try { setPriority(19); } catch {}
  if (process.platform === "linux") spawnSync("ionice", ["-c", "3", "-p", String(process.pid)], { stdio: "ignore", timeout: 2000 });
}

function main(): void {
  yieldTheDisk();
  const job = JSON.parse(readFileSync(0, "utf8")) as WalkJob;
  runJob(job, (result) => process.stdout.write(`${JSON.stringify(result)}\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
