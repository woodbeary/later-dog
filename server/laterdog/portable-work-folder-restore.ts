import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { basename, dirname, relative as relativePath, join } from "node:path";
import { z } from "zod";
import type { WorkFolderLayout } from "../../shared/work-folder-layout.ts";
import {
  materializedWorkFolderLink,
  validWorkFolderScope,
  type WorkFolderEntry,
} from "../../shared/work-folder-store.ts";
import { writeFileAtomic } from "../atomic.ts";
import { folderHash } from "./engine-folder-store.ts";
import { applyFolder, visitFolder, validateFolderHardlinks } from "./engine-folder-files.ts";
import {
  BackupFolderStore,
  PortableFolderReader,
  backupFolderAccess,
  portableFolderScopes,
  walkFolderObjects,
  type PortableAuthority,
  type PortableScope,
} from "./portable-work-folders.ts";
import { projectFolderId, projectLink, visibleWorkspace, visibleAliases } from "./work-folder-locations.ts";

const sha = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();
const stepsSchema = z
  .array(z.object({ owner: z.string(), id: z.string(), prior: sha, previousManifest: sha, manifest: sha }).strict())
  .max(100_000);
export type RestoreStep = z.infer<typeof stepsSchema>[number];
type Folder = PortableFolderReader["catalog"]["folders"][number];

export function restoredScopePath(layout: WorkFolderLayout, scope: PortableScope, id: string): string {
  if (!validWorkFolderScope(scope.owner, scope.id)) throw new Error("Invalid restored folder assignment.");
  if (scope.id === "dog") return join("workspaces", scope.owner);
  if (scope.id.startsWith("task-")) return join("task-workspaces", scope.owner, scope.id.slice(5));
  if (scope.id === "loose") return join("restored-work-folders-" + id, "files");
  const project = layout.projects.find((p) => p.owner === scope.owner && projectFolderId(p.path) === scope.id);
  if (!project) throw new Error("Unknown restored project.");
  return join("restored-work-folders-" + id, scope.id, basename(project.path));
}

type LocalProof = { kind: "dir" | "file" | "link"; mode?: number; sha256?: string; target?: string; hardlink?: string };

export async function restoreFoldersLocally(
  job: string,
  id: string,
  archive: PortableFolderReader,
  sourceDataDir: string,
) {
  const work = join(job, "assigned-data"),
    layout = archive.catalog.layout;
  mkdirSync(work, { mode: 0o700 });
  const paths: { source: string; relative: string; exact?: boolean }[] = [];
  const proofs = new Map<string, LocalProof>();
  function directory(path: string) {
    for (let dir = path; dir !== "."; dir = dirname(dir)) if (!proofs.has(dir)) proofs.set(dir, { kind: "dir" });
  }
  const projectTargets = new Map<string, string>();
  for (const p of layout.projects) {
    const folder = { owner: p.owner, id: projectFolderId(p.path) };
    const restored = restoredScopePath(layout, folder, id);
    paths.push({ source: p.path, relative: restored });
    projectTargets.set(folder.id, restored);
  }
  for (const f of archive.catalog.folders) {
    if (!f.manifest) continue;
    const scoped = restoredScopePath(layout, f, id);
    const dest = join(work, scoped);
    const project = layout.projects.find((p) => projectFolderId(p.path) === f.id);
    const original =
      project?.path ?? (f.id === "loose" ? visibleWorkspace(sourceDataDir) : join(sourceDataDir, scoped));
    const scope = { owner: f.owner, id: f.id, path: original };
    const targetOf = (entry: Extract<WorkFolderEntry, { kind: "link" }>) => {
      const projected = projectLink(layout, sourceDataDir, scope, entry.path, entry.target);
      if (!projected) return materializedWorkFolderLink(entry);
      const [projectId, ...tail] = projected.slice("/run/laterdog-work-folders/tree/".length).split("/");
      const sibling = projectTargets.get(projectId!);
      if (!sibling) throw new Error("Restored project link has no assigned destination.");
      return relativePath(dirname(join(scoped, entry.path)), join(sibling, ...tail)) || ".";
    };
    mkdirSync(dest, { mode: 0o700, recursive: true });
    const tree = await archive.tree(f.manifest);
    validateFolderHardlinks(tree);
    await applyFolder(archive, dest, await visitFolder(dest), tree, targetOf);
    directory(scoped);
    proofs.set(scoped, { kind: "dir", mode: tree.mode });
    for (const entry of tree.entries.values()) {
      const path = join(scoped, entry.path);
      if (entry.kind === "link") proofs.set(path, { kind: "link", target: targetOf(entry) });
      else if (entry.kind === "dir") proofs.set(path, { kind: "dir", mode: entry.mode });
      else
        proofs.set(path, {
          kind: "file",
          mode: entry.mode,
          sha256: entry.sha256,
          ...(entry.hardlink ? { hardlink: join(scoped, entry.hardlink) } : {}),
        });
    }
    if (f.id === "loose") {
      for (const alias of visibleAliases(layout, f.owner)) {
        const sibling = projectTargets.get(projectFolderId(alias.target))!;
        const path = join(scoped, alias.name),
          target = relativePath(scoped, sibling);
        if (proofs.has(path)) throw new Error("A restored shared project conflicts with an ordinary file.");
        symlinkSync(target, join(work, path));
        proofs.set(path, { kind: "link", target });
      }
      paths.push(
        { source: dirname(sourceDataDir), relative: scoped, exact: true },
        ...(layout.loose?.names ?? []).map((name) => ({
          source: join(dirname(sourceDataDir), name),
          relative: join(scoped, name),
        })),
        { source: visibleWorkspace(sourceDataDir), relative: scoped },
      );
    }
  }
  paths.sort((a, b) => b.source.length - a.source.length);
  writeFileAtomic(join(job, "assigned-paths.json"), JSON.stringify(paths), { mode: 0o600 });
  writeFileAtomic(join(job, "assigned-files.json"), JSON.stringify([...proofs]), { mode: 0o600 });
}

export function installLocalFolders(job: string, prepared: string, checksum: (path: string) => string) {
  const root = join(job, "assigned-data");
  if (!existsSync(root)) return;
  const proofs = new Map<string, LocalProof>(JSON.parse(readFileSync(join(job, "assigned-files.json"), "utf8")));
  function copy(path: string) {
    const from = join(root, path),
      to = join(prepared, path);
    const st = lstatSync(from),
      proof = proofs.get(path);
    if (!proof || (proof.mode !== undefined && proof.mode !== (st.mode & 0o7777)))
      throw new Error("Staged work folder entries do not match the backup.");
    proofs.delete(path);
    if (st.isDirectory() && proof.kind === "dir") {
      if (existsSync(to)) {
        if (!lstatSync(to).isDirectory())
          throw new Error("A restored work folder conflicts with another backed-up file.");
      } else mkdirSync(to, { mode: 0o700 });
      for (const name of readdirSync(from)) copy(join(path, name));
      chmodSync(to, st.mode & 0o7777);
      utimesSync(to, st.atime, st.mtime);
    } else if (st.isSymbolicLink() && proof.kind === "link" && readlinkSync(from) === proof.target)
      symlinkSync(proof.target, to);
    else if (st.isFile() && proof.kind === "file" && proof.sha256 === checksum(from)) {
      if (proof.hardlink) {
        const linked = lstatSync(join(root, proof.hardlink));
        if (linked.ino !== st.ino || linked.dev !== st.dev) throw new Error("A staged work folder hard link changed.");
      }
      linkSync(from, to);
    } else throw new Error("Staged working file failed its checksum or changed its link target.");
  }
  for (const name of readdirSync(root)) copy(name);
  if (proofs.size) throw new Error("Staged working files are missing.");
}

function sameMembers(left: { owner: string; members: string[] }, right: { owner: string; members: string[] }) {
  const original = new Set([left.owner, ...left.members]),
    current = new Set([right.owner, ...right.members]);
  return left.owner === right.owner && original.size === current.size && [...original].every((id) => current.has(id));
}
function destinationScope(layout: WorkFolderLayout, source: WorkFolderLayout, scope: Folder): PortableScope {
  if (scope.id === "dog" || scope.id.startsWith("task-")) return { owner: scope.owner, id: scope.id };
  if (scope.id === "loose" && layout.loose && source.loose && sameMembers(source.loose, layout.loose))
    return { owner: layout.loose.owner, id: "loose" };
  const src = source.projects.find((p) => p.owner === scope.owner && projectFolderId(p.path) === scope.id);
  const dst = src && layout.projects.find((p) => p.owner === src.owner && p.path === src.path && sameMembers(src, p));
  if (dst) return { owner: dst.owner, id: projectFolderId(dst.path) };
  throw new Error("The backup includes a shared folder without its matching destination assignment.");
}

export async function stageAssignedFolders(
  archive: PortableFolderReader,
  authority: PortableAuthority,
  layout: WorkFolderLayout,
): Promise<RestoreStep[]> {
  const steps: RestoreStep[] = [];
  const seen = new Set<string>();
  for (const folder of archive.catalog.folders) {
    const scope = destinationScope(layout, archive.catalog.layout, folder);
    const store = new BackupFolderStore(await backupFolderAccess(authority, scope));
    const current = await store.head();
    if (folder.manifest) await walkFolderObjects(folder.manifest, archive.read.bind(archive), store.put.bind(store));
    seen.add(scope.owner + "/" + scope.id);
    steps.push({
      ...scope,
      prior: current?.revision ?? null,
      previousManifest: current?.manifest ?? null,
      manifest: folder.manifest,
    });
  }
  for (const scope of portableFolderScopes(layout)) {
    if (seen.has(scope.owner + "/" + scope.id) || !(scope.id === "dog" || scope.id.startsWith("task-"))) continue;
    const store = new BackupFolderStore(await backupFolderAccess(authority, scope));
    const current = await store.head();
    if (current?.manifest)
      steps.push({ ...scope, prior: current.revision, previousManifest: current.manifest, manifest: null });
  }
  return steps;
}

export async function applyAssignedHeads(job: string, authority: PortableAuthority, action: "apply" | "rollback") {
  const file = join(job, "assigned-restore.json");
  if (!existsSync(file)) return;
  const steps = stepsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const prospective = (s: RestoreStep) => folderHash(JSON.stringify([1, s.prior, s.manifest]));
  for (const step of action === "apply" ? steps : [...steps].reverse()) {
    const store = new BackupFolderStore(await backupFolderAccess(authority, step));
    const now = await store.head(),
      current = now?.revision ?? null;
    if (step.manifest === step.previousManifest && (action === "rollback" || current === step.prior)) continue;
    const result = prospective(step);
    if (action === "rollback") {
      if (current !== result) continue;
      await store.commit(result, step.previousManifest);
      continue;
    }
    if (current === result) continue;
    if (current !== step.prior)
      throw new Error("A destination work folder changed after backup preview. Preview again before restoring.");
    const receipt = await store.commit(step.prior, step.manifest);
    if (receipt !== result || (await store.head())?.revision !== result)
      throw new Error("The work folder changed during restore.");
  }
}
