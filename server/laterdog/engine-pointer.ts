import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import { engineInventory, type EngineFile, type EngineFileRoot } from "./engine-files.ts";
import type { WorkspaceOwnership } from "./engine-remote.ts";
import { hashFile, manifestEntryBytes, WORKSPACE_CAPS, type ArtifactRef, type ManifestEntry, type WorkspaceCaps, type WorkspaceGit, type WorkspaceManifest } from "./engine-workspace.ts";

export const WORKSPACE_POINTERS = "engine-workspaces";
const HASH = /^[a-f0-9]{64}$/;
const KEY = /^[a-f0-9]{24}$/;
const BOT = /^[A-Za-z0-9_-]{1,128}$/;

export type PointerState = "held" | "home";
export interface WorkspacePointer {
  version: 1;
  botId: string;
  cwd: string;
  key: string;
  seededAt: number;
  writtenAt: number;
  state: PointerState;
  seeded: boolean;
  manifest: WorkspaceManifest | null;
  artifacts: ArtifactRef[];
  hold: { at: number; ok: boolean; why?: string } | null;
  broughtHome?: { at: number; files: number; bytes: number; conflicts: string[] };
  recovered?: { at: number; restored: number; missing: number };
}

export function workspaceKey(botId: string, cwd: string): string {
  return createHash("sha256").update(`${botId}\0${resolve(cwd)}`).digest("hex").slice(0, 24);
}

export function pointerPaths(dataDir: string, botId: string, cwd: string) {
  if (!BOT.test(botId)) throw new Error("Invalid dog id for a workspace pointer");
  const key = workspaceKey(botId, cwd);
  const dir = join(resolve(dataDir), WORKSPACE_POINTERS, botId, key);
  return { key, dir, file: join(dir, "pointer.json"), artifacts: join(dir, "artifacts"), git: join(dir, "git"), conflicts: join(dir, "conflicts") };
}

export function readPointer(dataDir: string, botId: string, cwd: string): WorkspacePointer | null {
  return readPointerFile(pointerPaths(dataDir, botId, cwd).file);
}

function readPointerFile(file: string): WorkspacePointer | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as WorkspacePointer;
    return parsed && parsed.version === 1 && typeof parsed.cwd === "string" && KEY.test(parsed.key) ? parsed : null;
  } catch { return null; }
}

export function savePointer(dataDir: string, pointer: WorkspacePointer): void {
  const paths = pointerPaths(dataDir, pointer.botId, pointer.cwd);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(paths.file, `${JSON.stringify(pointer)}\n`, { mode: 0o600 });
}

export function botPointers(dataDir: string, botId: string): WorkspacePointer[] {
  if (!BOT.test(botId)) return [];
  const dir = join(resolve(dataDir), WORKSPACE_POINTERS, botId);
  let keys: string[] = [];
  try { keys = readdirSync(dir).filter((name) => KEY.test(name)); } catch { return []; }
  return keys.map((key) => readPointerFile(join(dir, key, "pointer.json"))).filter((pointer): pointer is WorkspacePointer => pointer !== null);
}

export const computerOwnsWork = (pointer: WorkspacePointer | null): boolean => Boolean(pointer && pointer.state === "held" && pointer.seeded);
export const heldPointers = (dataDir: string, botId: string): WorkspacePointer[] => botPointers(dataDir, botId).filter((pointer) => pointer.state === "held");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const validPath = (path: unknown): path is string => typeof path === "string" && path.length > 0 && path.length <= 4096 && !path.includes("\0") && !path.startsWith("/")
  && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export function acceptManifest(raw: unknown, caps: WorkspaceCaps = WORKSPACE_CAPS): WorkspaceManifest {
  if (!isRecord(raw) || !Array.isArray(raw.files)) throw new Error("The computer sent an unreadable workspace manifest.");
  const at = count(raw.at);
  if (at === null) throw new Error("The workspace manifest has no time.");
  const files: ManifestEntry[] = [];
  let bytes = 0;
  let truncated = raw.truncated === true;
  const seen = new Set<string>();
  for (const entry of raw.files) {
    if (!isRecord(entry) || !validPath(entry.path) || count(entry.size) === null || typeof entry.hash !== "string" || !HASH.test(entry.hash) || seen.has(entry.path)) {
      throw new Error("The workspace manifest has an invalid entry.");
    }
    if (files.length >= caps.manifestFiles || bytes + manifestEntryBytes({ path: entry.path }) > caps.manifestBytes) { truncated = true; break; }
    seen.add(entry.path);
    files.push({ path: entry.path, size: entry.size as number, hash: entry.hash, mtimeMs: typeof entry.mtimeMs === "number" && Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : 0 });
    bytes += manifestEntryBytes({ path: entry.path });
  }
  const totalFiles = Math.max(count(raw.totalFiles) ?? 0, files.length);
  const totalBytes = Math.max(count(raw.totalBytes) ?? 0, files.reduce((sum, file) => sum + file.size, 0));
  if (totalFiles > files.length) truncated = true;
  return { at, files, totalFiles, totalBytes, truncated, git: acceptGit(raw.git) };
}

function acceptGit(raw: unknown): WorkspaceGit | null {
  if (!isRecord(raw)) return null;
  const text = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value) ? value : null;
  return {
    head: text(raw.head, /^[a-f0-9]{40,64}$/),
    branch: text(raw.branch, /^[^\0\n]{1,255}$/),
    patchHash: text(raw.patchHash, HASH),
    patchBytes: count(raw.patchBytes) ?? 0,
    patchTooLarge: raw.patchTooLarge === true,
  };
}

export class ArtifactBudget {
  readonly #sizes = new Map<string, number>();
  #total = 0;
  readonly caps: WorkspaceCaps;
  constructor(caps: WorkspaceCaps, existing: ReadonlyArray<Pick<EngineFile, "path" | "size">> = []) {
    this.caps = caps;
    for (const file of existing) { this.#sizes.set(file.path, file.size); this.#total += file.size; }
  }
  get total(): number { return this.#total; }
  get files(): number { return this.#sizes.size; }
  admit(path: string, size: number): string | null {
    const before = this.#sizes.get(path);
    if (size > this.caps.artifactFileBytes) return `artifact ${path} is ${size} bytes, over the ${this.caps.artifactFileBytes} byte file cap`;
    if (before === undefined && this.#sizes.size >= this.caps.artifactFiles) return `artifact ${path} would exceed the ${this.caps.artifactFiles} file cap`;
    if (this.#total - (before ?? 0) + size > this.caps.artifactTotalBytes) return `artifact ${path} would exceed the ${this.caps.artifactTotalBytes} byte total cap`;
    this.#total += size - (before ?? 0);
    this.#sizes.set(path, size);
    return null;
  }
  removed(path: string): void {
    const before = this.#sizes.get(path);
    if (before === undefined) return;
    this.#total -= before;
    this.#sizes.delete(path);
  }
}

export interface RecoveryPlan { overlay: Map<string, string>; missing: string[] }

export function recoveryPlan(pointer: WorkspacePointer, homeFiles: readonly EngineFile[], dataDir: string): RecoveryPlan {
  const paths = pointerPaths(dataDir, pointer.botId, pointer.cwd);
  const home = new Map(homeFiles.map((file) => [file.path, file.hash]));
  const overlay = new Map<string, string>();
  const missing: string[] = [];
  for (const entry of pointer.manifest?.files ?? []) {
    if (home.get(entry.path) === entry.hash) continue;
    const artifact = join(paths.artifacts, entry.path);
    let matches = false;
    try { matches = lstatSync(artifact).isFile() && hashFile(artifact).hash === entry.hash; } catch {}
    if (matches) overlay.set(entry.path, artifact);
    else missing.push(entry.path);
  }
  return { overlay, missing };
}

export function pointerRoots(dataDir: string, botId: string, cwd: string): { artifact: EngineFileRoot; git: EngineFileRoot } {
  const paths = pointerPaths(dataDir, botId, cwd);
  return {
    artifact: { id: "workspace-artifact", path: paths.artifacts, writable: true },
    git: { id: "workspace-git", path: paths.git, writable: true, files: ["work.patch"] },
  };
}

export function pointerArtifacts(dataDir: string, botId: string, cwd: string): EngineFile[] {
  const roots = pointerRoots(dataDir, botId, cwd);
  for (const root of [roots.artifact, roots.git]) mkdirSync(root.path, { recursive: true, mode: 0o700 });
  return engineInventory([roots.artifact, roots.git]);
}

export function beginOwnership(dataDir: string, botId: string, cwd: string, now = Date.now()): WorkspacePointer {
  const existing = readPointer(dataDir, botId, cwd);
  const key = workspaceKey(botId, cwd);
  if (existing && existing.state === "held") return existing;
  const pointer: WorkspacePointer = {
    version: 1, botId, cwd: resolve(cwd), key, seededAt: now, writtenAt: now, state: "held", seeded: false,
    manifest: null, artifacts: [], hold: existing?.hold ?? null,
    ...(existing?.broughtHome ? { broughtHome: existing.broughtHome } : {}),
  };
  savePointer(dataDir, pointer);
  return pointer;
}

export function recordManifest(dataDir: string, pointer: WorkspacePointer, manifest: WorkspaceManifest, artifacts: ArtifactRef[]): WorkspacePointer {
  const next: WorkspacePointer = { ...pointer, state: "held", manifest, artifacts, writtenAt: Math.max(pointer.writtenAt, manifest.at) };
  savePointer(dataDir, next);
  return next;
}

export function pointerSummary(pointer: WorkspacePointer) {
  return {
    cwd: pointer.cwd,
    key: pointer.key,
    state: pointer.state,
    seeded: pointer.seeded,
    writtenAt: new Date(pointer.writtenAt).toISOString(),
    seededAt: new Date(pointer.seededAt).toISOString(),
    files: pointer.manifest?.totalFiles ?? null,
    bytes: pointer.manifest?.totalBytes ?? null,
    listed: pointer.manifest?.files.length ?? 0,
    truncated: pointer.manifest?.truncated ?? false,
    artifacts: { files: pointer.artifacts.length, bytes: pointer.artifacts.reduce((sum, artifact) => sum + artifact.size, 0) },
    git: pointer.manifest?.git ?? null,
    hold: pointer.hold,
    ...(pointer.broughtHome ? { broughtHome: { ...pointer.broughtHome, at: new Date(pointer.broughtHome.at).toISOString() } } : {}),
  };
}

export const pointerExists = (dataDir: string, botId: string, cwd: string): boolean => existsSync(pointerPaths(dataDir, botId, cwd).file);

export interface OwnedWorkspaceInput { dataDir: string; botId: string; cwd: string; remoteBase: string; caps?: WorkspaceCaps; now?: () => number }

export function ownedWorkspace(input: OwnedWorkspaceInput): WorkspaceOwnership {
  const caps = input.caps ?? WORKSPACE_CAPS;
  const now = input.now ?? Date.now;
  const { dataDir, botId, cwd } = input;
  const paths = pointerPaths(dataDir, botId, cwd);
  const roots = pointerRoots(dataDir, botId, cwd);
  let pointer = readPointer(dataDir, botId, cwd);
  let budget = new ArtifactBudget(caps);
  const stored = () => pointerArtifacts(dataDir, botId, cwd);
  const artifactRefs = (files: EngineFile[]): ArtifactRef[] => files.filter((file) => file.root === roots.artifact.id).map((file) => ({ path: file.path, hash: file.hash, size: file.size }));
  const save = (next: WorkspacePointer) => { pointer = next; savePointer(dataDir, next); };
  return {
    root: "workspace",
    key: paths.key,
    homeFallback: !computerOwnsWork(pointer),
    outputs: [roots.artifact, roots.git],
    begin() {
      pointer = beginOwnership(dataDir, botId, cwd, now());
      budget = new ArtifactBudget(caps, stored().filter((file) => file.root === roots.artifact.id));
      return { reseed: !pointer.seeded };
    },
    configure() {
      const files = stored();
      return { root: "workspace", artifacts: artifactRefs(files).map(({ path, hash }) => ({ path, hash })), patchHash: files.find((file) => file.root === roots.git.id)?.hash ?? null,
        caps, cacheFile: `${input.remoteBase}/state/workspace-${paths.key}.json` };
    },
    recovery(homeFiles) {
      const plan = recoveryPlan(pointer!, homeFiles, dataDir);
      save({ ...pointer!, recovered: { at: now(), restored: plan.overlay.size, missing: plan.missing.length } });
      return plan;
    },
    seeded() { if (pointer && !pointer.seeded) save({ ...pointer, seeded: true }); },
    abandoned() { if (pointer && !pointer.seeded && pointer.state === "held") save({ ...pointer, state: "home" }); },
    admit(file) {
      if (file.root === roots.git.id) return file.size > caps.patchBytes ? `the git patch is ${file.size} bytes, over the ${caps.patchBytes} byte cap` : null;
      if (file.root !== roots.artifact.id) return null;
      return budget.admit(file.path, file.size);
    },
    removed(file) { if (file.root === roots.artifact.id) budget.removed(file.path); },
    manifest(raw) {
      const manifest = acceptManifest(raw, caps);
      pointer = recordManifest(dataDir, pointer!, manifest, artifactRefs(stored()));
      return pointer.writtenAt;
    },
    held(ok, why, writtenAt) {
      if (!pointer) return;
      const latest = ok && writtenAt !== undefined && pointer.state === "held" ? Math.max(pointer.writtenAt, writtenAt) : pointer.writtenAt;
      save({ ...pointer, writtenAt: latest, hold: { at: now(), ok, ...(why ? { why } : {}) } });
    },
  };
}
