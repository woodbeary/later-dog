import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export class MountDown extends Error {
  readonly code = "EMOUNTDOWN";
  readonly folder: string;
  constructor(folder: string) {
    super("This dog's folder is not answering right now; it was left unchanged and will be tried again shortly.");
    this.folder = folder;
  }
}

const TRIPPING = new Set(["EIO", "ETIMEDOUT", "ENOTCONN", "EHOSTDOWN", "ECONNABORTED", "ESTALE", "EMOUNTDOWN"]);

export interface MountGuardOptions {
  roots: () => readonly string[];
  timeoutMs?: number;
  coolMs?: number;
  perFolder?: number;
  inAll?: number;
  slowMs?: number;
  folders?: () => readonly string[];
  now?: () => number;
  probe?: (folder: string) => Promise<unknown>;
}

interface FolderState {
  running: number;
  ops: Set<Slot>;
  downUntil: number;
  probing: Promise<boolean> | null;
}

export interface MountGuard {
  folderOf(path: string): string | null;
  isDown(path: string): boolean;
  run<T>(path: string, op: () => Promise<T>): Promise<T>;
  state(): Array<{ folder: string; running: number; counted: number; waiting: number; downForMs: number }>;
}

export const MOUNT_OP_TIMEOUT_MS = 10_000;
export const MOUNT_COOL_MS = 30_000;
export const MOUNT_OPS_PER_FOLDER = 1;
export const MOUNT_OPS_IN_ALL = 8;
export const MOUNT_OP_SLOW_MS = 1_000;

interface Slot {
  counted: boolean;
  slow?: ReturnType<typeof setTimeout>;
}

export function createMountGuard(options: MountGuardOptions): MountGuard {
  const timeoutMs = options.timeoutMs ?? MOUNT_OP_TIMEOUT_MS;
  const coolMs = options.coolMs ?? MOUNT_COOL_MS;
  const perFolder = options.perFolder ?? MOUNT_OPS_PER_FOLDER;
  const inAll = options.inAll ?? MOUNT_OPS_IN_ALL;
  const slowMs = options.slowMs ?? MOUNT_OP_SLOW_MS;
  let runningInAll = 0;
  const now = options.now ?? (() => Date.now());
  const probe = options.probe ?? ((folder: string) => stat(folder));
  const folders = new Map<string, FolderState>();

  const folderOf = (path: string): string | null => {
    for (const folder of options.folders?.() ?? []) {
      if (path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`)) return folder;
    }
    for (const root of options.roots()) {
      const rel = relative(root, path);
      if (rel === "") return root;
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      return join(root, rel.split(sep)[0]!);
    }
    return null;
  };
  const stateOf = (folder: string): FolderState => {
    let found = folders.get(folder);
    if (!found) {
      found = { running: 0, ops: new Set(), downUntil: 0, probing: null };
      folders.set(folder, found);
    }
    return found;
  };
  const waiters = new Set<{ folder: string; take: () => boolean }>();
  const offer = () => { for (const waiter of waiters) waiter.take(); };
  const uncount = (slot: Slot) => {
    if (!slot.counted) return;
    slot.counted = false;
    runningInAll -= 1;
    offer();
  };
  const trip = (folder: string, state: FolderState) => {
    state.downUntil = now() + coolMs;
    for (const slot of state.ops) uncount(slot);
    offer();
    console.error(`mount guard: ${folder} is not answering; calls fail fast for ${Math.round(coolMs / 1000)} s`);
  };
  const timed = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("The folder did not answer in time."), { code: "ETIMEDOUT" })), timeoutMs);
    timer.unref?.();
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
  const acquire = (folder: string, state: FolderState): Promise<Slot> => new Promise<Slot>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter = {
      folder,
      take: () => {
        if (state.downUntil > now()) { finish(); reject(new MountDown(folder)); return true; }
        if (state.running >= perFolder || runningInAll >= inAll) return false;
        const slot: Slot = { counted: true };
        state.running += 1;
        state.ops.add(slot);
        runningInAll += 1;
        finish();
        slot.slow = setTimeout(() => uncount(slot), slowMs);
        slot.slow.unref?.();
        resolve(slot);
        return true;
      },
    };
    const finish = () => { if (timer) clearTimeout(timer); waiters.delete(waiter); };
    if (waiter.take()) return;
    waiters.add(waiter);
    timer = setTimeout(() => { finish(); reject(new MountDown(folder)); }, timeoutMs);
    timer.unref?.();
  });
  const release = (state: FolderState, slot: Slot) => {
    clearTimeout(slot.slow);
    state.running -= 1;
    state.ops.delete(slot);
    if (slot.counted) {
      slot.counted = false;
      runningInAll -= 1;
    }
    offer();
  };
  const tripping = (error: unknown) => TRIPPING.has(String((error as NodeJS.ErrnoException | null)?.code));
  const guarded = async <T>(folder: string, state: FolderState, op: () => Promise<T>): Promise<T> => {
    const slot = await acquire(folder, state);
    const work = Promise.resolve().then(op);
    work.then(() => release(state, slot), () => release(state, slot));
    try {
      return await timed(work);
    } catch (error) {
      if (tripping(error)) trip(folder, state);
      throw tripping(error) && !(error instanceof MountDown) ? new MountDown(folder) : error;
    }
  };
  const recovered = (folder: string, state: FolderState): Promise<boolean> => {
    state.probing ??= guarded(folder, state, () => probe(folder)).then(() => {
      state.downUntil = 0;
      return true;
    }, () => false).finally(() => { state.probing = null; });
    return state.probing;
  };

  return {
    folderOf,
    isDown(path) {
      const folder = folderOf(path);
      return folder !== null && (folders.get(folder)?.downUntil ?? 0) > now();
    },
    async run(path, op) {
      const folder = folderOf(path);
      if (!folder) return op();
      const state = stateOf(folder);
      if (state.downUntil > now()) throw new MountDown(folder);
      if (state.downUntil > 0 && !(await recovered(folder, state))) throw new MountDown(folder);
      return guarded(folder, state, op);
    },
    state() {
      return [...folders].map(([folder, state]) => ({ folder, running: state.running, counted: [...state.ops].filter((slot) => slot.counted).length, waiting: [...waiters].filter((waiter) => waiter.folder === folder).length, downForMs: Math.max(0, state.downUntil - now()) }));
    },
  };
}

export interface MountFiles {
  mkdir(path: string): Promise<void>;
  readText(path: string): Promise<string | null>;
  lstat(path: string): Promise<Stats | null>;
  realpath(path: string): Promise<string>;
  writeAtomic(path: string, data: string): Promise<void>;
  unlink(path: string): Promise<void>;
  statOf(path: string): Promise<Stats>;
  list(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

export function mountFiles(guard: MountGuard): MountFiles {
  return {
    async mkdir(path) { await guard.run(path, () => mkdir(path, { recursive: true, mode: 0o700 })); },
    readText: (path) => guard.run(path, () => readFile(path, "utf8").catch((error: unknown) => { if (missing(error)) return null; throw error; })),
    lstat: (path) => guard.run(path, (): Promise<Stats | null> => lstat(path).catch((error: unknown) => { if (missing(error)) return null; throw error; })),
    realpath: (path) => guard.run(path, () => realpath(path)),
    async writeAtomic(path, data) {
      await guard.run(path, async () => {
        const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, path).catch(async (error: unknown) => { await unlink(temporary).catch(() => {}); throw error; });
      });
    },
    async unlink(path) { await guard.run(path, () => unlink(path).catch((error: unknown) => { if (!missing(error)) throw error; })); },
    statOf: (path) => guard.run(path, (): Promise<Stats> => stat(path)),
    list: (path) => guard.run(path, () => readdir(path).catch((error: unknown) => { if (missing(error)) return [] as string[]; throw error; })),
    async remove(path) { await guard.run(path, () => rm(path, { recursive: true, force: true })); },
  };
}
