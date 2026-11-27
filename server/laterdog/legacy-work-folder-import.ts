import { createHash } from "node:crypto";
import {
  WORK_FOLDER_BLOB_BYTES,
  compareWorkFolderPaths,
  validWorkFolderScope,
  type WorkFolderEntry,
  type WorkFolderNode,
} from "../../shared/work-folder-store.ts";
import type { WorkFolderLayout } from "../../shared/work-folder-layout.ts";
import { folderHash, folderManifestPages } from "./engine-folder-store.ts";
import type { RestoreStep } from "./portable-work-folder-restore.ts";
import {
  BackupFolderStore,
  backupFolderAccess,
  portableFolderScopes,
  type PortableAuthority,
  type PortableScope,
} from "./portable-work-folders.ts";

type LegacyEntry = { path: string; type: "file" | "directory"; size: number; mode: number; sha256?: string };
type IncomingFolder = {
  scope: PortableScope;
  store: BackupFolderStore;
  mode: number;
  entries: WorkFolderEntry[];
  prior: string | null;
  previousManifest: string | null;
};

function managedPath(path: string) {
  const [top, owner, thread, ...more] = path.split("/");
  if (top !== "workspaces" && top !== "task-workspaces") return null;
  const invalid = () => {
    throw new Error("Invalid assigned work folder in legacy backup.");
  };
  if (!owner || (top === "task-workspaces" && !thread)) return { scope: null, inside: "" };
  const id = top === "workspaces" ? "dog" : "task-" + thread;
  if (!validWorkFolderScope(owner, id)) return invalid();
  return {
    scope: { owner, id },
    inside: top === "workspaces" ? [thread, ...more].filter(Boolean).join("/") : more.join("/"),
  };
}

export const archivedManagedPath = (path: string) => managedPath(path) !== null;

export class LegacyFolderImport {
  private folders = new Map<string, IncomingFolder>();
  private readonly authority: PortableAuthority;
  private readonly layout: WorkFolderLayout;
  constructor(authority: PortableAuthority, layout: WorkFolderLayout) {
    this.authority = authority;
    this.layout = layout;
  }
  private async folder(scope: PortableScope) {
    const key = scope.owner + "/" + scope.id;
    const previous = this.folders.get(key);
    if (previous) return previous;
    const store = new BackupFolderStore(await backupFolderAccess(this.authority, scope));
    const before = await store.head();
    const folder: IncomingFolder = {
      scope,
      store,
      mode: 0o700,
      entries: [],
      prior: before?.revision ?? null,
      previousManifest: before?.manifest ?? null,
    };
    this.folders.set(key, folder);
    return folder;
  }
  async accept(entry: LegacyEntry, stream: AsyncIterable<Buffer>) {
    const target = managedPath(entry.path);
    if (!target) throw new Error("Expected a managed legacy working folder.");
    if (!target.inside && entry.type !== "directory")
      throw new Error("A legacy working folder root is not a directory.");
    if (!target.scope) return;
    const folder = await this.folder(target.scope);
    if (!target.inside) {
      folder.mode = entry.mode;
      return;
    }
    if (entry.type === "directory") {
      folder.entries.push({ path: target.inside, kind: "dir", mode: entry.mode });
      return;
    }
    const hash = createHash("sha256");
    const hashes: string[] = [];
    let size = 0,
      used = 0;
    const buffer = Buffer.allocUnsafe(Math.min(WORK_FOLDER_BLOB_BYTES, entry.size));
    const flush = async () => {
      const slice = buffer.subarray(0, used),
        digest = folderHash(slice);
      await folder.store.put("blobs", digest, slice);
      hashes.push(digest);
      used = 0;
    };
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > entry.size) throw new Error("Legacy working file exceeds its declared size.");
      hash.update(chunk);
      for (let pos = 0; pos < chunk.length; ) {
        const take = Math.min(chunk.length - pos, buffer.length - used);
        chunk.copy(buffer, used, pos, pos + take);
        used += take;
        pos += take;
        if (used === buffer.length) await flush();
      }
    }
    if (used) await flush();
    if (size !== entry.size || hash.digest("hex") !== entry.sha256)
      throw new Error("A legacy work folder file failed its checksum.");
    const contents = await folderManifestPages("chunks", hashes, (node) => this.page(folder, node));
    folder.entries.push({ kind: "file", path: target.inside, size, sha256: entry.sha256!, mode: entry.mode, contents });
  }
  private async page(folder: IncomingFolder, node: WorkFolderNode) {
    const bytes = Buffer.from(JSON.stringify(node)),
      hash = folderHash(bytes);
    await folder.store.put("manifests", hash, bytes);
    return hash;
  }
  async stage(): Promise<RestoreStep[]> {
    const steps: RestoreStep[] = [];
    for (const f of this.folders.values()) {
      const entries = await folderManifestPages(
        "entries",
        f.entries.sort((a, b) => compareWorkFolderPaths(a.path, b.path)),
        (node) => this.page(f, node),
      );
      const manifest = await this.page(f, { v: 1, kind: "root", mode: f.mode, entries });
      steps.push({ ...f.scope, prior: f.prior, previousManifest: f.previousManifest, manifest });
    }
    for (const scope of portableFolderScopes(this.layout)) {
      if (this.folders.has(scope.owner + "/" + scope.id) || !(scope.id === "dog" || scope.id.startsWith("task-")))
        continue;
      const store = new BackupFolderStore(await backupFolderAccess(this.authority, scope));
      const current = await store.head();
      if (current?.manifest)
        steps.push({ ...scope, prior: current.revision, previousManifest: current.manifest, manifest: null });
    }
    return steps;
  }
  names() {
    const dogs = new Set<string>(),
      tasks: Record<string, string[]> = Object.create(null);
    for (const f of this.folders.values()) {
      if (f.scope.id === "dog") dogs.add(f.scope.owner);
      else (tasks[f.scope.owner] ??= []).push(f.scope.id.slice(5));
    }
    return { dogs: [...dogs], tasks };
  }
}
