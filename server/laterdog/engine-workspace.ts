import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { engineFilePath, ENGINE_SKIPPED_DIRECTORIES, type EngineFileRoot } from "./engine-files.ts";

export interface WorkspaceCaps {
  manifestFiles: number;
  manifestBytes: number;
  artifactFiles: number;
  artifactFileBytes: number;
  artifactTotalBytes: number;
  patchBytes: number;
}

export const WORKSPACE_CAPS: WorkspaceCaps = {
  manifestFiles: 20_000,
  manifestBytes: 2 * 1024 * 1024,
  artifactFiles: 2_000,
  artifactFileBytes: 1024 * 1024,
  artifactTotalBytes: 16 * 1024 * 1024,
  patchBytes: 2 * 1024 * 1024,
};

export interface ManifestEntry { path: string; size: number; hash: string; mtimeMs: number }
export interface WorkspaceGit { head: string | null; branch: string | null; patchHash: string | null; patchBytes: number; patchTooLarge: boolean }
export interface WorkspaceManifest {
  at: number;
  files: ManifestEntry[];
  totalFiles: number;
  totalBytes: number;
  truncated: boolean;
  git: WorkspaceGit | null;
}
export interface ArtifactRef { path: string; hash: string; size: number }

const ENTRY_OVERHEAD = 96;
export const manifestEntryBytes = (entry: Pick<ManifestEntry, "path">) => Buffer.byteLength(entry.path) + ENTRY_OVERHEAD;

export function hashFile(path: string): { hash: string; size: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Workspace entry is not a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) { hash.update(buffer.subarray(0, read)); size += read; }
    return { hash: hash.digest("hex"), size };
  } finally { closeSync(fd); }
}

export function walkWorkspace(root: string, visit: (path: string, full: string) => void, skip: ReadonlySet<string> = ENGINE_SKIPPED_DIRECTORIES): void {
  const walk = (at: string) => {
    const full = at ? join(root, at) : root;
    let entries;
    try { entries = readdirSync(full, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const path = at ? `${at}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) visit(path, join(root, path));
    }
  };
  walk("");
}

export function workspaceHasFiles(root: string): boolean {
  let found = false;
  try { for (const entry of readdirSync(root)) if (!ENGINE_SKIPPED_DIRECTORIES.has(entry)) { found = true; break; } } catch {}
  return found;
}

export function workspaceManifest(root: string, caps: WorkspaceCaps = WORKSPACE_CAPS, previous: readonly ManifestEntry[] = [], now = Date.now()): WorkspaceManifest {
  const known = new Map(previous.map((entry) => [entry.path, entry]));
  const files: ManifestEntry[] = [];
  let bytes = 0;
  let totalFiles = 0;
  let totalBytes = 0;
  let truncated = false;
  walkWorkspace(root, (path, full) => {
    let stat;
    try { stat = lstatSync(full); } catch { return; }
    if (!stat.isFile()) return;
    totalFiles += 1;
    totalBytes += stat.size;
    if (truncated || files.length >= caps.manifestFiles || bytes + manifestEntryBytes({ path }) > caps.manifestBytes) { truncated = true; return; }
    const before = known.get(path);
    let hash = before && before.size === stat.size && before.mtimeMs === stat.mtimeMs ? before.hash : "";
    if (!hash) { try { hash = hashFile(full).hash; } catch { totalFiles -= 1; totalBytes -= stat.size; return; } }
    files.push({ path, size: stat.size, hash, mtimeMs: stat.mtimeMs });
    bytes += manifestEntryBytes({ path });
  });
  return { at: now, files, totalFiles, totalBytes, truncated, git: null };
}

export function pickArtifacts(manifest: Pick<WorkspaceManifest, "files">, caps: WorkspaceCaps = WORKSPACE_CAPS, reserved = 0): ArtifactRef[] {
  const chosen: ArtifactRef[] = [];
  let total = reserved;
  const newest = [...manifest.files].sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
  for (const entry of newest) {
    if (chosen.length >= caps.artifactFiles) break;
    if (entry.size > caps.artifactFileBytes || total + entry.size > caps.artifactTotalBytes) continue;
    chosen.push({ path: entry.path, hash: entry.hash, size: entry.size });
    total += entry.size;
  }
  return chosen;
}

export function workspaceGit(root: string, caps: WorkspaceCaps = WORKSPACE_CAPS): { git: WorkspaceGit; patch: Buffer | null } | null {
  const run = (args: string[], maxBuffer = 64 * 1024) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer, timeout: 30_000 });
  try { if (run(["rev-parse", "--show-toplevel"]).toString().trim() !== root) return null; } catch { return null; }
  let head: string | null = null;
  let branch: string | null = null;
  try { head = run(["rev-parse", "--verify", "HEAD"]).toString().trim() || null; } catch {}
  try { branch = run(["symbolic-ref", "--short", "-q", "HEAD"]).toString().trim() || null; } catch {}
  if (!head) return { git: { head, branch, patchHash: null, patchBytes: 0, patchTooLarge: false }, patch: null };
  let patch: Buffer | null = null;
  let tooLarge = false;
  try { patch = run(["diff", "--binary", "--no-ext-diff", "HEAD"], caps.patchBytes); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOBUFS") tooLarge = true; }
  if (patch && patch.length > caps.patchBytes) { patch = null; tooLarge = true; }
  const patchHash = patch && patch.length ? createHash("sha256").update(patch).digest("hex") : null;
  return { git: { head, branch, patchHash, patchBytes: patch?.length ?? 0, patchTooLarge: tooLarge }, patch: patch && patch.length ? patch : null };
}

export function readWorkspaceFile(root: EngineFileRoot, name: string, limit: number): { bytes: Buffer; hash: string } {
  const path = engineFilePath(root, name);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Not a regular file");
    if (stat.size > limit) throw new Error(`The file is ${stat.size} bytes, over the ${limit} byte read limit`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) { const read = readSync(fd, bytes, offset, stat.size - offset, offset); if (read <= 0) break; offset += read; }
    const exact = bytes.subarray(0, offset);
    return { bytes: exact, hash: createHash("sha256").update(exact).digest("hex") };
  } finally { closeSync(fd); }
}
