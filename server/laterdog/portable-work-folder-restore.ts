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
import { basename, join } from "node:path";
import { z } from "zod";
import type { WorkFolderLayout } from "../../shared/work-folder-layout.ts";
import { validWorkFolderScope } from "../../shared/work-folder-store.ts";
import { writeFileAtomic } from "../atomic.ts";
import { folderHash } from "./engine-folder-store.ts";
import { applyFolder, visitFolder } from "./engine-folder-files.ts";
import {
  BackupFolderStore,
  PortableFolderReader,
  backupFolderAccess,
  portableFolderScopes,
  walkFolderObjects,
  type PortableAuthority,
  type PortableScope,
} from "./portable-work-folders.ts";
import { projectFolderId } from "./work-folder-locations.ts";

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

export async function restoreFoldersLocally(job: string, id: string, archive: PortableFolderReader) {
  const root = join(job, "assigned-data");
  mkdirSync(root, { mode: 0o700 });
  const paths: { source: string; relative: string }[] = [];
  for (const f of archive.catalog.folders) {
    if (!f.manifest) continue;
    const relative = restoredScopePath(archive.catalog.layout, f, id);
    const dest = join(root, relative);
    mkdirSync(dest, { mode: 0o700, recursive: true });
    const tree = await archive.tree(f.manifest);
    await applyFolder(archive, dest, await visitFolder(dest), tree);
    const project = archive.catalog.layout.projects.find((p) => projectFolderId(p.path) === f.id);
    if (project) paths.push({ source: project.path, relative });
  }
  writeFileAtomic(join(job, "assigned-paths.json"), JSON.stringify(paths), { mode: 0o600 });
}

export function installLocalFolders(job: string, prepared: string) {
  const source = join(job, "assigned-data");
  if (!existsSync(source)) return;
  function copy(from: string, to: string) {
    const st = lstatSync(from);
    if (st.isDirectory()) {
      if (existsSync(to)) {
        if (!lstatSync(to).isDirectory())
          throw new Error("A restored work folder conflicts with another backed-up file.");
      } else mkdirSync(to, { mode: 0o700 });
      for (const name of readdirSync(from)) copy(join(from, name), join(to, name));
      chmodSync(to, st.mode & 0o7777);
      utimesSync(to, st.atime, st.mtime);
    } else if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else if (st.isFile()) linkSync(from, to);
    else throw new Error("Unexpected file type in restored work folder.");
  }
  for (const name of readdirSync(source)) copy(join(source, name), join(prepared, name));
}

function destinationScope(layout: WorkFolderLayout, source: WorkFolderLayout, scope: Folder): PortableScope {
  if (scope.id === "dog" || scope.id.startsWith("task-")) return { owner: scope.owner, id: scope.id };
  if (scope.id === "loose" && layout.loose) return { owner: layout.loose.owner, id: "loose" };
  const src = source.projects.find((p) => p.owner === scope.owner && projectFolderId(p.path) === scope.id);
  const dst =
    src &&
    layout.projects.find(
      (p) =>
        p.owner === src.owner &&
        p.path === src.path &&
        src.members.every((id) => id === p.owner || p.members.includes(id)),
    );
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
