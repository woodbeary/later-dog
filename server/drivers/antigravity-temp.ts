// Adapted from pingdotgg/t3code@c18e5ea6ed, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/antigravityAuthSupport.ts:187-212, 238-253
//     (a short temp folder per instance, beside rather than inside the
//     profile, and TEMP/TMP pointed at it for the runtime);
//   - apps/server/src/provider/acp/AntigravitySessionFiles.ts:45-61 and
//     apps/server/src/provider/Drivers/AntigravityDriver.ts:121-132
//     (reclaim what earlier runs left behind when the driver starts).
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { DATA_DIR } from "../config.ts";

const UNPACK_PREFIX = "_MEI";
const CLAIM_PREFIX = ".laterdog-removing-";
const ANTIGRAVITY_MARKERS = ["agy_acp_licenses.txt", "python310.dll"] as const;
export const SYSTEM_LEFTOVER_MIN_AGE_MS = 10 * 60_000;
const INSTANCE_FOLDER = /^[0-9a-f]{12}$/u;

export function antigravityTempRoot(dataDir: string = DATA_DIR): string {
  return join(dataDir, "tmp", "agy");
}

export const VERIFICATION_TEMP_KEY = "runtime verification";

export function antigravityTempDir(dataDir: string, instanceId: string): string {
  const key = createHash("sha256").update(instanceId).digest("hex").slice(0, 12);
  return join(antigravityTempRoot(dataDir), key);
}

export function setAntigravityTempEnvironment(
  environment: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  for (const key of Object.keys(environment)) {
    const upper = key.toUpperCase();
    if (upper === "TEMP" || upper === "TMP") delete environment[key];
  }
  environment.TEMP = directory;
  environment.TMP = directory;
}

export function unpackFolderOwnerPids(name: string): number[] | null {
  if (!name.startsWith(UNPACK_PREFIX)) return null;
  const rest = name.slice(UNPACK_PREFIX.length);
  const pids = new Set<number>();
  if (/^[0-9a-f]{8}\d+$/iu.test(rest)) pids.add(Number.parseInt(rest.slice(0, 8), 16));
  if (/^[1-9]\d+$/u.test(rest)) {
    for (let counter = 1; counter <= 3 && counter < rest.length; counter++) {
      pids.add(Number.parseInt(rest.slice(0, rest.length - counter), 10));
    }
  }
  const valid = [...pids].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  return valid.length ? valid : null;
}

export function processIsAlive(
  pid: number,
  kill: (pid: number, signal: 0) => unknown = (target, signal) => process.kill(target, signal),
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

export interface AntigravityTempOptions {
  dataDir?: string;
  isAlive?: (pid: number) => boolean;
}

export interface LeftoverFolder {
  path: string;
  where: "app" | "system";
  bytes: number;
}

export interface LeftoverScan {
  folders: LeftoverFolder[];
  bytes: number;
  complete: boolean;
}

export interface LeftoverRemoval {
  removed: number;
  freedBytes: number;
  remaining: number;
}

function ownedByDeadProcess(name: string, isAlive: (pid: number) => boolean): boolean {
  const pids = unpackFolderOwnerPids(name);
  return pids !== null && !pids.some((pid) => isAlive(pid));
}

async function entryKind(path: string): Promise<"directory" | "gone" | "other"> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() ? "directory" : "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "gone" : "other";
  }
}

async function realDirectory(path: string): Promise<boolean> {
  return (await entryKind(path)) === "directory";
}

async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function ownedTempDirectories(dataDir: string, only?: string): Promise<string[]> {
  const root = resolve(antigravityTempRoot(dataDir));
  let realRoot: string;
  try {
    const realData = await realpath(resolve(dataDir));
    realRoot = await realpath(root);
    if (realRoot !== join(realData, "tmp", "agy")) return [];
  } catch {
    return [];
  }
  const names = only === undefined
    ? (await listDirectory(root)).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [only];
  const owned: string[] = [];
  for (const name of names) {
    if (!INSTANCE_FOLDER.test(name)) continue;
    const directory = join(root, name);
    try {
      if (await realpath(directory) !== join(realRoot, name)) continue;
    } catch {
      continue;
    }
    owned.push(directory);
  }
  return owned;
}

async function abandonedIn(directory: string, isAlive: (pid: number) => boolean): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await listDirectory(directory)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(CLAIM_PREFIX) || ownedByDeadProcess(entry.name, isAlive)) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

async function isAntigravityUnpack(directory: string): Promise<boolean> {
  for (const marker of ANTIGRAVITY_MARKERS) {
    try {
      if (!(await lstat(join(directory, marker))).isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function systemLeftovers(
  systemTemp: string,
  isAlive: (pid: number) => boolean,
  now: number,
): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await listDirectory(systemTemp)) {
    if (!entry.isDirectory()) continue;
    const directory = join(systemTemp, entry.name);
    const claimed = entry.name.startsWith(CLAIM_PREFIX + UNPACK_PREFIX);
    if (!claimed && !ownedByDeadProcess(entry.name, isAlive)) continue;
    if (!claimed && !(await isAntigravityUnpack(directory))) continue;
    try {
      if (now - (await lstat(directory)).mtimeMs < SYSTEM_LEFTOVER_MIN_AGE_MS) continue;
    } catch {
      continue;
    }
    found.push(directory);
  }
  return found;
}

async function folderBytes(directory: string, deadline = Infinity): Promise<{ bytes: number; complete: boolean }> {
  let bytes = 0;
  const pending = [directory];
  while (pending.length) {
    if (Date.now() > deadline) return { bytes, complete: false };
    const current = pending.pop()!;
    for (const entry of await listDirectory(current)) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try { bytes += (await lstat(path)).size; } catch {}
      }
    }
  }
  return { bytes, complete: true };
}

async function claimAndRemove(directory: string, countBytes: boolean): Promise<number | "gone" | null> {
  const name = basename(directory);
  const kind = await entryKind(directory);
  if (kind !== "directory") return kind === "gone" ? "gone" : null;
  let claimed = directory;
  if (!name.startsWith(CLAIM_PREFIX)) {
    claimed = join(dirname(directory), `${CLAIM_PREFIX}${name}-${randomUUID().slice(0, 8)}`);
    try {
      await rename(directory, claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && (await entryKind(directory)) === "gone") return "gone";
      return null;
    }
  }
  const { bytes } = countBytes ? await folderBytes(claimed) : { bytes: 0 };
  try {
    await rm(claimed, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return bytes;
  } catch {
    return null;
  }
}

const sweeps = new Map<string, Promise<number>>();

export function sweepAntigravityTemp(instanceId: string, options: AntigravityTempOptions = {}): Promise<number> {
  const dataDir = options.dataDir ?? DATA_DIR;
  const key = antigravityTempDir(dataDir, instanceId);
  const running = sweeps.get(key);
  if (running) return running;
  const sweep = (async () => {
    const isAlive = options.isAlive ?? processIsAlive;
    let removed = 0;
    for (const directory of await ownedTempDirectories(dataDir, basename(key))) {
      for (const folder of await abandonedIn(directory, isAlive)) {
        if (typeof await claimAndRemove(folder, false) === "number") removed++;
      }
    }
    return removed;
  })().finally(() => sweeps.delete(key));
  sweeps.set(key, sweep);
  return sweep;
}

export function scheduleAntigravityTempSweep(instanceId: string, options: AntigravityTempOptions = {}): void {
  void sweepAntigravityTemp(instanceId, options).catch((error) => {
    console.warn(`antigravity: could not clear leftover runtime files: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export interface LeftoverOptions extends AntigravityTempOptions {
  systemTemp?: string;
  platform?: NodeJS.Platform;
  now?: number;
  budgetMs?: number;
}

async function leftoverCandidates(options: LeftoverOptions): Promise<Array<{ path: string; where: "app" | "system" }>> {
  const isAlive = options.isAlive ?? processIsAlive;
  const candidates: Array<{ path: string; where: "app" | "system" }> = [];
  for (const directory of await ownedTempDirectories(options.dataDir ?? DATA_DIR)) {
    for (const path of await abandonedIn(directory, isAlive)) candidates.push({ path, where: "app" });
  }
  if ((options.platform ?? process.platform) === "win32") {
    const systemTemp = await realpath(resolve(options.systemTemp ?? tmpdir())).catch(() => null);
    if (systemTemp && await realDirectory(systemTemp)) {
      for (const path of await systemLeftovers(systemTemp, isAlive, options.now ?? Date.now())) {
        candidates.push({ path, where: "system" });
      }
    }
  }
  return candidates;
}

export async function findAntigravityLeftovers(options: LeftoverOptions = {}): Promise<LeftoverScan> {
  const deadline = Date.now() + (options.budgetMs ?? 15_000);
  const folders: LeftoverFolder[] = [];
  let complete = true;
  for (const candidate of await leftoverCandidates(options)) {
    const counted = await folderBytes(candidate.path, deadline);
    complete &&= counted.complete;
    folders.push({ ...candidate, bytes: counted.bytes });
  }
  return { folders, bytes: folders.reduce((total, folder) => total + folder.bytes, 0), complete };
}

export async function removeAntigravityLeftovers(options: LeftoverOptions = {}): Promise<LeftoverRemoval> {
  const deadline = Date.now() + (options.budgetMs ?? 120_000);
  const candidates = await leftoverCandidates(options);
  let removed = 0;
  let alreadyGone = 0;
  let freedBytes = 0;
  for (const candidate of candidates) {
    if (Date.now() > deadline) break;
    const bytes = await claimAndRemove(candidate.path, true);
    if (bytes === "gone") alreadyGone++;
    if (typeof bytes !== "number") continue;
    removed++;
    freedBytes += bytes;
  }
  return { removed, freedBytes, remaining: candidates.length - removed - alreadyGone };
}
