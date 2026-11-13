import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { setPriority } from "node:os";
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
  overEstimate?: true;
}

type Kind = "files" | "generated" | "history";

interface Pending {
  path: Buffer;
  name: string;
  kind: Kind;
  dev: number;
}

export const SHARED_LIMIT = 5_000_000;
const FIRST_SLOTS = 1 << 16;
const MAX_LOAD = 0.625;

export class InodeSet {
  private slots: Float64Array;
  private count: number;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
    this.slots = new Float64Array(FIRST_SLOTS);
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  get bytes(): number {
    return this.slots.byteLength;
  }

  private static spot(slots: Float64Array, ino: number): number {
    const mask = slots.length - 1;
    const low = ino >>> 0;
    const high = Math.floor(ino / 4294967296) >>> 0;
    let at = (Math.imul(low ^ Math.imul(high, 0x85ebca6b), 0x9e3779b1) >>> 0) & mask;
    while (slots[at] !== 0 && slots[at] !== ino) at = (at + 1) & mask;
    return at;
  }

  has(ino: number): boolean {
    return ino !== 0 && this.slots[InodeSet.spot(this.slots, ino)] === ino;
  }

  add(ino: number): boolean {
    if (ino === 0 || this.count >= this.limit) return false;
    if ((this.count + 1) / this.slots.length > MAX_LOAD) this.grow();
    const at = InodeSet.spot(this.slots, ino);
    if (this.slots[at] === ino) return true;
    this.slots[at] = ino;
    this.count++;
    return true;
  }

  private grow(): void {
    const next = new Float64Array(this.slots.length * 2);
    for (const ino of this.slots) if (ino !== 0) next[InodeSet.spot(next, ino)] = ino;
    this.slots = next;
  }
}

export interface WalkState {
  clock: () => number;
  pause: () => void;
  pauseEvery: number;
  generated: ReadonlySet<string>;
  shared: InodeSet;
  seen: number;
}

const SCRATCH_PARENT = ".wrangler";
const SCRATCH_CHILD = "tmp";
const HISTORY = ".git";
const SLASH = Buffer.from("/");

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
    shared: new InodeSet(job.sharedLimit ?? SHARED_LIMIT),
    seen: 0,
  };
}

function kindIn(parent: Pending, name: string, state: WalkState, split: boolean): Kind {
  if (parent.kind !== "files" || !split) return parent.kind;
  if (state.generated.has(name)) return "generated";
  if (name === SCRATCH_CHILD && parent.name === SCRATCH_PARENT) return "generated";
  if (name === HISTORY) return "history";
  return "files";
}

const vanished = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

export function walkTree(root: WalkRoot, deadline: number, state: WalkState): WalkResult {
  const totals: Record<Kind, number> = { files: 0, generated: 0, history: 0 };
  const skip = (root.skip ?? []).map((path) => Buffer.from(path));
  const pending: Pending[] = [];
  let atLeast = false;
  let stopped = false;
  let overEstimate = false;
  const count = (path: Buffer, name: string, kind: Kind, dev: number | null) => {
    let info;
    try { info = lstatSync(path); } catch (error) {
      if (!vanished(error)) atLeast = true;
      return;
    }
    if (dev !== null && info.dev !== dev) return;
    const folder = info.isDirectory();
    if (folder && skip.some((skipped) => skipped.equals(path))) return;
    if (!folder && info.nlink > 1) {
      if (state.shared.has(info.ino)) return;
      if (!state.shared.add(info.ino)) overEstimate = true;
    }
    totals[kind] += info.blocks * 512;
    if (folder) pending.push({ path, name, kind, dev: info.dev });
  };
  for (const path of root.paths) count(Buffer.from(path), "", "files", null);
  while (pending.length) {
    if (state.clock() >= deadline) { stopped = true; break; }
    const dir = pending.pop()!;
    let names: Buffer[];
    try { names = readdirSync(dir.path, { encoding: "buffer" }); } catch (error) {
      if (!vanished(error)) atLeast = true;
      continue;
    }
    for (const raw of names) {
      const name = raw.toString();
      count(Buffer.concat([dir.path, SLASH, raw]), name, kindIn(dir, name, state, Boolean(root.split)), dir.dev);
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
    ...(overEstimate ? { overEstimate: true as const } : {}),
  };
}

export function runJob(job: WalkJob, write: (result: WalkResult) => void, state: WalkState = walkState(job)): void {
  const end = state.clock() + job.totalLimitMs;
  for (const root of job.roots) {
    const deadline = Math.min(end, state.clock() + (root.limitMs ?? job.rootLimitMs));
    write(walkTree(root, deadline, state));
  }
}

export function stopWhenOrphaned(state: WalkState, parent: number, currentParent: () => number, leave: () => void): WalkState {
  const rest = state.pause;
  return { ...state, pause: () => { rest(); if (currentParent() !== parent) leave(); } };
}

function yieldTheDisk(): void {
  try { setPriority(19); } catch {}
  if (process.platform === "linux") spawnSync("ionice", ["-c", "3", "-p", String(process.pid)], { stdio: "ignore", timeout: 2000 });
}

function main(): void {
  yieldTheDisk();
  const parent = process.ppid;
  const job = JSON.parse(readFileSync(0, "utf8")) as WalkJob;
  const state = stopWhenOrphaned(walkState(job), parent, () => process.ppid, () => process.exit(3));
  process.stdout.on("error", () => process.exit(3));
  runJob(job, (result) => process.stdout.write(`${JSON.stringify(result)}\n`), state);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
