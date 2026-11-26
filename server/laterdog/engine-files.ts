import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync, readdirSync, readFileSync, readSync, renameSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { TRANSFER_SPACE_MARGIN, freeVolumeBytes } from "./volume-space.ts";
import { isGeneratedPath } from "./build-output-path.ts";

export interface EngineFileRoot {
  id: string;
  path: string;
  writable: boolean;
  files?: string[];
  bounded?: { fileBytes: number; totalBytes: number; exclude?: string[] };
  readOnly?: boolean;
  pushOnly?: boolean;
  transcript?: boolean;
  streamedTree?: boolean;
  logicalPath?: string;
}
export type EngineFilePrefix = { size: number; hash: string };
export interface EngineFile { root: string; path: string; hash: string; size: number; mode: number; link?: string }
export const ENGINE_FILE_LIMIT = 128 * 1024 * 1024;
export const ENGINE_TRANSFER_LIMIT = 512 * 1024 * 1024;
const SKIP = new Set([".pnpm-store", ".npm", "dist", "build", "out", "coverage", "test-results", "playwright-report"]);
export const ENGINE_FRAME_BYTES = 32 * 1024;
export const ENGINE_WINDOW_BYTES = 1024 * 1024;
export const engineFileKey = (file: Pick<EngineFile, "root" | "path">) => `${file.root}\0${file.path}`;

export function engineFilePath(root: EngineFileRoot, name: string, allowLeafLink = false): string {
  if (!name || name.includes("\0") || isAbsolute(name) || name.split("/").some(part => part === ".." || part === "." || !part)) throw new Error("Invalid engine file path");
  const target = resolve(root.path, name);
  const rel = relative(root.path, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Engine file outside its folder");
  let current = root.path;
  for (const part of ["", ...name.split("/")]) {
    current = part ? join(current, part) : current;
    try { if (lstatSync(current).isSymbolicLink() && !(allowLeafLink && current === target && streamedTree(root))) throw new Error("Engine sync refuses symbolic links"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}

export function readEngineFile(root: EngineFileRoot, name: string): Buffer {
  const path = engineFilePath(root, name);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > ENGINE_FILE_LIMIT) throw new Error("Engine file cannot be transferred safely");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function selectedTranscript(root: EngineFileRoot, name: string): boolean {
  return root.transcript === true && root.writable && !root.bounded && !root.readOnly && !root.pushOnly && root.files?.length === 1 && root.files[0] === name && name.endsWith(".jsonl");
}

export function streamedTree(root: EngineFileRoot): boolean {
  return (root.id === "workspace" || root.id === "providerSessions") && root.streamedTree === true && root.writable && !root.files && !root.bounded && !root.readOnly && !root.pushOnly;
}

function linkTarget(root: EngineFileRoot, name: string, target: string): string {
  if (!streamedTree(root) || !target || target.includes("\0") || Buffer.byteLength(target) > 4096) throw new Error("Invalid working folder link");
  const from = dirname(engineFilePath(root, name, true));
  const logical = root.logicalPath ?? root.path;
  const absolute = isAbsolute(target) ? resolve(root.path, relative(logical, target)) : resolve(from, target);
  const inside = (path: string) => {
    const rel = relative(root.path, path);
    return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
  };
  if (absolute === engineFilePath(root, name, true) || !inside(absolute)) throw new Error(`The link ${name} leaves its assigned working folder. Its original was preserved.`);
  let existing = absolute;
  while (!lstatSync(existing, { throwIfNoEntry: false }) && existing !== root.path) existing = dirname(existing);
  try {
    if (!inside(realpathSync(existing))) throw new Error(`The link ${name} leaves its assigned working folder. Its original was preserved.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(`The link ${name} has an unresolved link in its target path. Its original was preserved.`);
  }
  return isAbsolute(target) ? absolute : target;
}

function residentLink(root: EngineFileRoot, name: string, path: string): string {
  const local = readlinkSync(path);
  const target = isAbsolute(local) && root.logicalPath ? resolve(root.logicalPath, relative(root.path, local)) : local;
  linkTarget(root, name, target);
  return target;
}

export function sameEngineFile(left?: EngineFile, right?: EngineFile): boolean {
  return left?.hash === right?.hash && left?.mode === right?.mode && left?.link === right?.link;
}

export function workspaceRecovery(root: string, home: readonly EngineFile[], computer: readonly EngineFile[], previous: readonly EngineFile[]) {
  const byName = (files: readonly EngineFile[]) => new Map(files.filter(file => file.root === root).map(file => [file.path, file]));
  const local = byName(home), remote = byName(computer), baseline = byName(previous);
  const changes: { root: string; path: string; hash?: string; mode?: number }[] = [];
  for (const path of new Set([...remote.keys(), ...baseline.keys()])) {
    const here = local.get(path), there = remote.get(path), before = baseline.get(path);
    if (sameEngineFile(here, there) || sameEngineFile(there, before)) continue;
    if (!sameEngineFile(here, before)) throw new Error(`The working file ${path} changed on both computers. Both copies were preserved.`);
    changes.push({ root, path, hash: there?.hash, mode: there?.mode });
  }
  return changes;
}

export function selectEngineTranscript(root: EngineFileRoot | undefined, name: string): void {
  if (root?.id !== "sessions" || !root.transcript || !root.writable || root.files?.length !== 0 || !name.endsWith(".jsonl")) throw new Error("Engine transcript selection cannot be changed");
  engineFilePath(root, name);
  root.files.push(name);
}

function fileSizeAllowed(root: EngineFileRoot, name: string, size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0 && (size <= ENGINE_FILE_LIMIT || selectedTranscript(root, name) || streamedTree(root));
}

export function decodeEngineChunk(data: unknown): Buffer {
  if (typeof data !== "string" || !data.length || data.length > 4 * Math.ceil(ENGINE_FRAME_BYTES / 3)) throw new Error("Invalid engine file frame size");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > ENGINE_FRAME_BYTES) throw new Error("Invalid engine file chunk size");
  return bytes;
}

export function* engineFileChunks(root: EngineFileRoot, name: string, chunkSize = ENGINE_FRAME_BYTES, start = 0, end?: number): Generator<Buffer> {
  const path = engineFilePath(root, name, true);
  if (streamedTree(root) && lstatSync(path).isSymbolicLink()) {
    const bytes = Buffer.from(residentLink(root, name, path));
    if (start || (end !== undefined && end !== bytes.length)) throw new Error("Working folder link changed during transfer");
    yield bytes;
    return;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !fileSizeAllowed(root, name, stat.size)) throw new Error("Engine file cannot be transferred safely");
    const limit = end ?? stat.size;
    if (start < 0 || start > limit || limit > stat.size) throw new Error("Engine file no longer covers its checkpoint");
    const buffer = Buffer.allocUnsafe(Math.min(chunkSize, limit - start));
    let offset = start;
    while (offset < limit) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, limit - offset), offset);
      if (!count) throw new Error("Engine file shortened during transfer");
      offset += count;
      yield buffer.subarray(0, count);
    }
    const after = fstatSync(fd);
    if (end === undefined) {
      const resident = lstatSync(path);
      if (resident.ino !== stat.ino || resident.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Engine file changed during transfer");
    }
  } finally { closeSync(fd); }
}

type FileWork<T> = Generator<void, T>;

function finishFileWork<T>(work: FileWork<T>): T {
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

export async function runFileWork<T>(work: FileWork<T>, signal?: AbortSignal, onProgress?: () => void): Promise<T> {
  let lastYield = performance.now();
  let step = work.next();
  while (!step.done) {
    if (performance.now() - lastYield >= 6) {
      await yieldToIO();
      if (signal?.aborted) work.throw(new Error("Engine file transfer interrupted"));
      onProgress?.();
      lastYield = performance.now();
    }
    step = work.next();
  }
  return step.value;
}

function* fileHash(root: EngineFileRoot, name: string, end?: number): FileWork<string> {
  const hash = createHash("sha256");
  for (const chunk of engineFileChunks(root, name, ENGINE_WINDOW_BYTES, 0, end)) { hash.update(chunk); yield; }
  return hash.digest("hex");
}

export function matchingTranscriptPrefix(root: EngineFileRoot, file: EngineFile, before?: EngineFile): EngineFilePrefix | undefined {
  return finishFileWork(transcriptPrefixWork(root, file, before));
}

export function* transcriptPrefixWork(root: EngineFileRoot, file: EngineFile, before?: EngineFile): FileWork<EngineFilePrefix | undefined> {
  if (!selectedTranscript(root, file.path) || file.size <= ENGINE_FILE_LIMIT || !before || !Number.isSafeInteger(before.size) || before.size <= 0 || before.size >= file.size) return;
  if ((yield* fileHash(root, file.path, before.size)) === before.hash) return { size: before.size, hash: before.hash };
}

export function engineInventory(roots: readonly EngineFileRoot[]): EngineFile[] {
  return finishFileWork(inventoryWork(roots));
}

export function* inventoryWork(roots: readonly EngineFileRoot[]): FileWork<EngineFile[]> {
  const files: EngineFile[] = [];
  let total = 0;
  let rootTotal = 0;
  function* add(root: EngineFileRoot, path: string): FileWork<void> {
    const full = engineFilePath(root, path, true);
    if (!streamedTree(root) && (isGeneratedPath(path) || path.split("/").some(part => SKIP.has(part)))) return;
    let stat;
    try { stat = lstatSync(full); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (root.bounded) {
      if (!stat.isFile() || stat.size > root.bounded.fileBytes || rootTotal + stat.size > root.bounded.totalBytes) return;
      rootTotal += stat.size;
    }
    if (streamedTree(root) && stat.isSymbolicLink()) {
      const target = residentLink(root, path, full);
      files.push({ root: root.id, path, hash: createHash("sha256").update(target).digest("hex"), size: Buffer.byteLength(target), mode: stat.mode & 0o777, link: target });
      return;
    }
    if (!stat.isFile()) throw new Error("Engine sync needs regular files");
    if (!selectedTranscript(root, path) && !streamedTree(root)) total += stat.size;
    if (!fileSizeAllowed(root, path, stat.size) || total > ENGINE_TRANSFER_LIMIT) throw new Error("Engine workspace is too large to transfer safely");
    files.push({ root: root.id, path, hash: yield* fileHash(root, path), size: stat.size, mode: stat.mode & 0o777 });
  }
  function* walk(root: EngineFileRoot, at: string): FileWork<void> {
    const full = at ? engineFilePath(root, at) : root.path;
    if (!existsSync(full)) return;
    if (lstatSync(full).isSymbolicLink()) throw new Error("Engine sync refuses symbolic links");
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      yield;
      const path = at ? `${at}/${entry.name}` : entry.name;
      if (!streamedTree(root) && (SKIP.has(entry.name) || isGeneratedPath(path) || root.bounded?.exclude?.includes(path))) continue;
      if (entry.isDirectory()) yield* walk(root, path);
      else if (entry.isFile() || (entry.isSymbolicLink() && streamedTree(root))) yield* add(root, path);
      else if (streamedTree(root)) throw new Error(`The working folder contains an unsupported special file at ${path}. Its original was preserved.`);
      else if (entry.isSymbolicLink() && !root.bounded) yield* add(root, path);
    }
  }
  for (const root of roots) {
    rootTotal = 0;
    if (root.files) for (const file of root.files) yield* add(root, file);
    else yield* walk(root, "");
  }
  return files;
}

export class EngineFileReceiver {
  readonly roots: ReadonlyMap<string, EngineFileRoot>;
  readonly baseline = new Map<string, EngineFile>();
  #open: { fd: number; path: string; temp: string; file: EngineFile; size: number; hash: ReturnType<typeof createHash> } | null = null;
  #received = 0;
  #spaceCheckAt = 0;

  constructor(roots: readonly EngineFileRoot[], baseline: readonly EngineFile[] = []) {
    this.roots = new Map(roots.map(root => [root.id, root]));
    for (const file of baseline) this.baseline.set(engineFileKey(file), file);
  }

  begin(file: EngineFile, prefix?: EngineFilePrefix): void { finishFileWork(this.beginWork(file, prefix)); }

  *beginWork(file: EngineFile, prefix?: EngineFilePrefix): FileWork<void> {
    if (this.#open) throw new Error("Engine file transfer already in progress");
    const root = this.roots.get(file.root);
    if (!root || !root.writable || (root.files && !root.files.includes(file.path))) throw new Error("Engine file is outside the writable selection");
    if (!fileSizeAllowed(root, file.path, file.size) || !/^[a-f0-9]{64}$/.test(file.hash)) throw new Error("Invalid engine file metadata");
    const transcript = selectedTranscript(root, file.path);
    const workspace = streamedTree(root);
    if (!transcript && !workspace) this.#received += file.size;
    if (this.#received > ENGINE_TRANSFER_LIMIT) throw new Error("Engine checkpoint exceeds its limit");
    const path = engineFilePath(root, file.path, true);
    if (file.link !== undefined) {
      linkTarget(root, file.path, file.link);
      if (file.size !== Buffer.byteLength(file.link) || file.hash !== createHash("sha256").update(file.link).digest("hex")) throw new Error("Invalid working folder link metadata");
    }
    const before = this.baseline.get(engineFileKey(file));
    if (prefix && (!transcript || !before || !Number.isSafeInteger(prefix.size) || prefix.size <= 0 || prefix.size >= file.size || prefix.size !== before.size || prefix.hash !== before.hash)) throw new Error("Invalid engine transcript prefix");
    if (lstatSync(path, { throwIfNoEntry: false }) && !prefix) {
      const actual = yield* fileHash(root, file.path);
      const mode = lstatSync(path).mode & 0o777;
      if (workspace && mode !== before?.mode && mode !== file.mode) throw new Error("Engine file permissions conflict with a newer home copy");
      if (actual !== before?.hash && actual !== file.hash) throw new Error("Engine file conflicts with a newer home copy");
    } else if (before && !lstatSync(path, { throwIfNoEntry: false })) throw new Error("Engine file was removed on the home");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if ((transcript || workspace) && freeVolumeBytes(dirname(path)) - TRANSFER_SPACE_MARGIN < file.size) throw new Error(
      workspace ? "Insufficient disk space for the working folder checkpoint" : "Insufficient disk space for the native transcript checkpoint");
    this.#spaceCheckAt = workspace ? ENGINE_WINDOW_BYTES : Infinity;
    const temp = `${path}.engine-${process.pid}-${Date.now()}`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.#open = { fd, path, temp, file, size: 0, hash: createHash("sha256") };
    if (prefix) {
      try {
        for (const bytes of engineFileChunks(root, file.path, ENGINE_WINDOW_BYTES, 0, prefix.size)) { this.chunk(bytes); yield; }
        if (this.#open.hash.copy().digest("hex") !== prefix.hash) throw new Error("Engine transcript conflicts with a newer copy");
      } catch (error) {
        this.close();
        throw error;
      }
    }
  }

  chunk(bytes: Buffer): void {
    const open = this.#open;
    if (!open || open.size + bytes.length > open.file.size) throw new Error("Invalid engine file chunk");
    if (open.size + bytes.length >= this.#spaceCheckAt) {
      if (freeVolumeBytes(dirname(open.path)) - TRANSFER_SPACE_MARGIN < open.file.size - open.size) throw new Error("Insufficient disk space for the working folder checkpoint");
      this.#spaceCheckAt = open.size + bytes.length + ENGINE_WINDOW_BYTES;
    }
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(open.fd, bytes, offset, bytes.length - offset);
    open.hash.update(bytes);
    open.size += bytes.length;
  }

  end(): void { finishFileWork(this.endWork()); }

  *endWork(): FileWork<void> {
    const open = this.#open;
    if (!open) throw new Error("No engine file in progress");
    this.#open = null;
    try {
      closeSync(open.fd);
      if (open.size !== open.file.size || open.hash.digest("hex") !== open.file.hash) throw new Error("Engine file did not match its checkpoint");
      const root = this.roots.get(open.file.root)!;
      const before = this.baseline.get(engineFileKey(open.file));
      const path = engineFilePath(root, open.file.path, true);
      if (lstatSync(path, { throwIfNoEntry: false })) {
        const actual = yield* fileHash(root, open.file.path);
        const mode = lstatSync(path).mode & 0o777;
        if (streamedTree(root) && mode !== before?.mode && mode !== open.file.mode) throw new Error("Engine file permissions changed while its checkpoint arrived");
        if (actual !== before?.hash && actual !== open.file.hash) throw new Error("Engine file changed while its checkpoint arrived");
      } else if (before) throw new Error("Engine file was removed during its checkpoint");
      if (open.file.link !== undefined) {
        const target = linkTarget(root, open.file.path, open.file.link);
        unlinkSync(open.temp);
        symlinkSync(target, open.temp);
      } else chmodSync(open.temp, open.file.mode & 0o777);
      renameSync(open.temp, path);
      this.baseline.set(engineFileKey(open.file), open.file);
    } catch (error) {
      if (lstatSync(open.temp, { throwIfNoEntry: false })) unlinkSync(open.temp);
      throw error;
    }
  }

  remove(file: Pick<EngineFile, "root" | "path">): void { finishFileWork(this.removeWork(file)); }

  *removeWork(file: Pick<EngineFile, "root" | "path">): FileWork<void> {
    const root = this.roots.get(file.root);
    if (!root || !root.writable || (root.files && !root.files.includes(file.path))) throw new Error("Engine deletion outside the writable selection");
    const path = engineFilePath(root, file.path, true);
    if (!lstatSync(path, { throwIfNoEntry: false })) { this.baseline.delete(engineFileKey(file)); return; }
    const before = this.baseline.get(engineFileKey(file));
    if (!before || (yield* fileHash(root, file.path)) !== before.hash) throw new Error("Engine deletion conflicts with a newer home copy");
    if (streamedTree(root) && (lstatSync(path).mode & 0o777) !== before.mode) throw new Error("Engine deletion conflicts with newer file permissions");
    unlinkSync(path);
    this.baseline.delete(engineFileKey(file));
  }

  resetBudget(): void { this.#received = 0; }
  close(): void {
    const open = this.#open;
    this.#open = null;
    if (open) { closeSync(open.fd); try { unlinkSync(open.temp); } catch {} }
  }
}
