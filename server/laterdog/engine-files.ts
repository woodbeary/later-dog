import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface EngineFileRoot {
  id: string;
  path: string;
  writable: boolean;
  files?: string[];
  bounded?: { fileBytes: number; totalBytes: number; exclude?: string[] };
  readOnly?: boolean;
}
export interface EngineFile { root: string; path: string; hash: string; size: number; mode: number }
export const ENGINE_FILE_LIMIT = 128 * 1024 * 1024;
export const ENGINE_TRANSFER_LIMIT = 512 * 1024 * 1024;
export const ENGINE_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".pnpm-store", ".npm", ".cache", "dist", "build", "out", "coverage", "test-results", "playwright-report"]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const engineFileKey = (file: Pick<EngineFile, "root" | "path">) => `${file.root}\0${file.path}`;

export function engineFilePath(root: EngineFileRoot, name: string): string {
  if (!name || name.includes("\0") || isAbsolute(name) || name.split("/").some(part => part === ".." || part === "." || !part)) throw new Error("Invalid engine file path");
  const target = resolve(root.path, name);
  const rel = relative(root.path, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Engine file outside its folder");
  let current = root.path;
  for (const part of ["", ...name.split("/")]) {
    current = part ? join(current, part) : current;
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Engine sync refuses symbolic links"); }
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

export function engineInventory(roots: readonly EngineFileRoot[]): EngineFile[] {
  const files: EngineFile[] = [];
  let total = 0;
  let rootTotal = 0;
  const add = (root: EngineFileRoot, path: string) => {
    const full = engineFilePath(root, path);
    let stat;
    try { stat = lstatSync(full); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (root.bounded) {
      if (!stat.isFile() || stat.size > root.bounded.fileBytes || rootTotal + stat.size > root.bounded.totalBytes) return;
      rootTotal += stat.size;
    }
    if (!stat.isFile()) throw new Error("Engine sync needs regular files");
    total += stat.size;
    if (stat.size > ENGINE_FILE_LIMIT || total > ENGINE_TRANSFER_LIMIT) throw new Error("Engine workspace is too large to transfer safely");
    const bytes = readEngineFile(root, path);
    files.push({ root: root.id, path, hash: digest(bytes), size: bytes.length, mode: stat.mode & 0o777 });
  };
  const walk = (root: EngineFileRoot, at: string) => {
    const full = at ? engineFilePath(root, at) : root.path;
    if (!existsSync(full)) return;
    if (lstatSync(full).isSymbolicLink()) throw new Error("Engine sync refuses symbolic links");
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (ENGINE_SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = at ? `${at}/${entry.name}` : entry.name;
      if (root.bounded?.exclude?.includes(path)) continue;
      if (entry.isDirectory()) walk(root, path);
      else if (entry.isFile() || (entry.isSymbolicLink() && !root.bounded)) add(root, path);
    }
  };
  for (const root of roots) {
    rootTotal = 0;
    if (root.files) for (const file of root.files) add(root, file);
    else walk(root, "");
  }
  return files;
}

export class EngineFileReceiver {
  readonly roots: ReadonlyMap<string, EngineFileRoot>;
  readonly baseline = new Map<string, EngineFile>();
  #open: { fd: number; path: string; temp: string; file: EngineFile; size: number; hash: ReturnType<typeof createHash> } | null = null;
  #received = 0;

  constructor(roots: readonly EngineFileRoot[], baseline: readonly EngineFile[] = []) {
    this.roots = new Map(roots.map(root => [root.id, root]));
    for (const file of baseline) this.baseline.set(engineFileKey(file), file);
  }

  begin(file: EngineFile): void {
    if (this.#open) throw new Error("Engine file transfer already in progress");
    const root = this.roots.get(file.root);
    if (!root || !root.writable || (root.files && !root.files.includes(file.path))) throw new Error("Engine file is outside the writable selection");
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > ENGINE_FILE_LIMIT || !/^[a-f0-9]{64}$/.test(file.hash)) throw new Error("Invalid engine file metadata");
    this.#received += file.size;
    if (this.#received > ENGINE_TRANSFER_LIMIT) throw new Error("Engine checkpoint exceeds its limit");
    const path = engineFilePath(root, file.path);
    const before = this.baseline.get(engineFileKey(file));
    if (existsSync(path)) {
      const actual = digest(readEngineFile(root, file.path));
      if (actual !== before?.hash && actual !== file.hash) throw new Error("Engine file conflicts with a newer home copy");
    } else if (before) throw new Error("Engine file was removed on the home");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.engine-${process.pid}-${Date.now()}`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.#open = { fd, path, temp, file, size: 0, hash: createHash("sha256") };
  }

  chunk(bytes: Buffer): void {
    const open = this.#open;
    if (!open || open.size + bytes.length > open.file.size) throw new Error("Invalid engine file chunk");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(open.fd, bytes, offset, bytes.length - offset);
    open.hash.update(bytes);
    open.size += bytes.length;
  }

  end(): void {
    const open = this.#open;
    if (!open) throw new Error("No engine file in progress");
    this.#open = null;
    closeSync(open.fd);
    if (open.size !== open.file.size || open.hash.digest("hex") !== open.file.hash) {
      unlinkSync(open.temp);
      throw new Error("Engine file did not match its checkpoint");
    }
    const root = this.roots.get(open.file.root)!;
    const before = this.baseline.get(engineFileKey(open.file));
    if (existsSync(open.path)) {
      const actual = digest(readEngineFile(root, open.file.path));
      if (actual !== before?.hash && actual !== open.file.hash) {
        unlinkSync(open.temp);
        throw new Error("Engine file changed while its checkpoint arrived");
      }
    } else if (before) { unlinkSync(open.temp); throw new Error("Engine file was removed during its checkpoint"); }
    engineFilePath(root, open.file.path);
    chmodSync(open.temp, open.file.mode & 0o777);
    renameSync(open.temp, open.path);
    this.baseline.set(engineFileKey(open.file), open.file);
  }

  remove(file: Pick<EngineFile, "root" | "path">): void {
    const root = this.roots.get(file.root);
    if (!root || !root.writable || (root.files && !root.files.includes(file.path))) throw new Error("Engine deletion outside the writable selection");
    const path = engineFilePath(root, file.path);
    if (!existsSync(path)) { this.baseline.delete(engineFileKey(file)); return; }
    const before = this.baseline.get(engineFileKey(file));
    if (!before || digest(readEngineFile(root, file.path)) !== before.hash) throw new Error("Engine deletion conflicts with a newer home copy");
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
