import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import {
  materializedWorkFolderLink,
  type WorkFolderEntry,
  type WorkFolderGrant,
} from "../../shared/work-folder-store.ts";
import { FolderStore, folderHash, type FolderTree } from "./engine-folder-store.ts";
import {
  applyFolder,
  equalTree,
  mergeFolder,
  uploadChanged,
  visitFolder,
  validateFolderHardlinks,
  type FolderVisit,
} from "./engine-folder-files.ts";

export const ENGINE_FOLDER_STATE = "/home/dog/.laterdog-engine/work-folders";
export interface EngineWorkFolder {
  path: string;
  grant: WorkFolderGrant;
  aliases?: { name: string; target: string }[];
  linkProjects?: string[];
}
interface SavedVisit {
  version: 1;
  uri: string;
  guest: string;
  revision: string;
  manifest: string;
  mode: number;
  mtimeMs?: number;
  rootId?: string;
  files: { entry: WorkFolderEntry; stamp: string }[];
}
const read = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const write = (file: string, value: unknown) => writeFileAtomic(file, JSON.stringify(value), { mode: 0o600 });

export function guestFolderDir(path: string, state = ENGINE_FOLDER_STATE): string {
  if (
    !isAbsolute(path) ||
    path !== resolve(path) ||
    path === "/" ||
    path === "/data" ||
    path === "/home" ||
    path === "/home/dog" ||
    path.startsWith("/proc/") ||
    path.startsWith("/sys/") ||
    path.startsWith("/dev/") ||
    state === path ||
    state.startsWith(path + sep) ||
    path.startsWith(state + sep)
  )
    throw new Error("Invalid assigned working folder");
  return join(state, folderHash(path));
}

function ensureRealDirectory(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) ensureRealDirectory(parent);
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
    throw new Error("Working folder route passes through a symbolic link");
}

function validateLinks(tree: FolderTree): void {
  validateFolderHardlinks(tree);
  for (const e of tree.entries.values()) {
    if (e.kind !== "link") continue;
    const cwd = e.path.split("/").slice(0, -1),
      todo = materializedWorkFolderLink(e).split("/");
    let followed = 0;
    while (todo.length) {
      const part = todo.shift()!;
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!cwd.length) throw new Error("Working folder link resolves outside its assignment: " + e.path);
        cwd.pop();
        continue;
      }
      const next = tree.entries.get([...cwd, part].join("/"));
      if (next?.kind === "link") {
        if (++followed > 40) break;
        todo.unshift(...materializedWorkFolderLink(next).split("/"));
        continue;
      }
      cwd.push(part);
    }
  }
}

function requireProject(binding: EngineWorkFolder, state: string, project: string, dataRoot: string): void {
  if (dirname(project) !== dataRoot || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(basename(project)))
    throw new Error("Invalid named working project");
  const dir = guestFolderDir(project, state),
    identity = join(dir, "grant.json");
  const known = existsSync(identity) ? read<EngineWorkFolder>(identity) : null;
  if (
    !known ||
    !existsSync(project) ||
    realpathSync(project) !== project ||
    known.path !== project ||
    known.grant.guestId !== binding.grant.guestId ||
    new URL(known.grant.baseUrl).origin !== new URL(binding.grant.baseUrl).origin ||
    !new URL(known.grant.baseUrl).pathname.endsWith("/project-" + folderHash(project)) ||
    !existsSync(join(dir, "checked.json"))
  )
    throw new Error("The shared project has no verified checkout on this computer");
}

function aliasEntries(binding: EngineWorkFolder, state: string, dataRoot: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const alias of binding.aliases ?? []) {
    if (
      binding.path !== join(dataRoot, ".laterdog-owned-work/visible") ||
      !new URL(binding.grant.baseUrl).pathname.endsWith("/loose") ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(alias.name) ||
      links.has(alias.name)
    )
      throw new Error("Invalid shared project alias in the loose working folder");
    const target = join(dataRoot, alias.name),
      link = "../../" + alias.name;
    if (alias.target !== target && alias.target !== link)
      throw new Error("Shared project alias does not identify its assigned path");
    requireProject(binding, state, target, dataRoot);
    links.set(alias.name, link);
  }
  return links;
}

function reconcileAliases(
  path: string,
  previous: Map<string, string>,
  next: Map<string, string>,
  remote: FolderTree,
): void {
  for (const [name, target] of new Map([...previous, ...next])) {
    const dest = join(path, name),
      s = lstatSync(dest, { throwIfNoEntry: false });
    if (s && (!s.isSymbolicLink() || readlinkSync(dest) !== target))
      throw new Error("A working file conflicts with the shared project alias: " + name);
    if (next.has(name) && remote.entries.has(name))
      throw new Error("A durable working file conflicts with the shared project alias: " + name);
  }
  const old = lstatSync(path, { bigint: true });
  let changed = false;
  for (const [name] of previous)
    if (!next.has(name) && lstatSync(join(path, name), { throwIfNoEntry: false })) {
      unlinkSync(join(path, name));
      changed = true;
    }
  for (const [name, target] of next)
    if (!lstatSync(join(path, name), { throwIfNoEntry: false })) {
      symlinkSync(target, join(path, name));
      changed = true;
    }
  if (changed) utimesSync(path, Number(old.atimeNs / 1000n) / 1e6, Number(old.mtimeNs / 1000n) / 1e6);
}

export async function syncFolder(
  binding: EngineWorkFolder,
  state = ENGINE_FOLDER_STATE,
  signal?: AbortSignal,
  progress = () => {},
  dataRoot = "/data",
): Promise<{ revision: string; manifest: string; changed: boolean }> {
  const dir = guestFolderDir(binding.path, state);
  ensureRealDirectory(dir);
  const identity = join(dir, "grant.json"),
    snapshot = join(dir, "checked.json");
  const prior = existsSync(identity) ? read<EngineWorkFolder>(identity) : undefined;
  if (
    prior &&
    (prior.path !== binding.path ||
      prior.grant.baseUrl !== binding.grant.baseUrl ||
      prior.grant.guestId !== binding.grant.guestId)
  )
    throw new Error("Working folder assignment differs from the existing guest checkout");
  const previousAliases = new Map((prior?.aliases ?? []).map((alias) => [alias.name, "../../" + alias.name]));
  if (binding.aliases === undefined && prior?.aliases) binding = { ...binding, aliases: prior.aliases };
  if (binding.linkProjects === undefined && prior?.linkProjects)
    binding = { ...binding, linkProjects: prior.linkProjects };
  const projects = binding.linkProjects ?? [];
  for (const project of projects) requireProject(binding, state, project, dataRoot);
  const linkFor = (entry: Extract<WorkFolderEntry, { kind: "link" }>) => {
    const inert = materializedWorkFolderLink(entry);
    if (entry.scopedTarget !== null) return inert;
    const from = dirname(join(binding.path, entry.path)),
      to = resolve(from, entry.target);
    const project = projects.find((p) => p === to || to.startsWith(p + sep));
    if (!project) return inert;
    try {
      const actual = realpathSync(to);
      return actual === project || actual.startsWith(project + sep) ? relative(from, to) : inert;
    } catch (error) {
      if (["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return inert;
      throw error;
    }
  };
  const aliases = aliasEntries(binding, state, dataRoot);
  const store = new FolderStore(binding.grant, (grant) => write(identity, { ...binding, grant }), signal, progress);
  if (!prior) write(identity, binding);
  const saved = existsSync(snapshot) ? read<SavedVisit>(snapshot) : undefined;
  if (saved && (saved.version !== 1 || saved.uri !== binding.grant.baseUrl || saved.guest !== binding.grant.guestId))
    throw new Error("Working folder checkpoint belongs to another assignment");
  const before: FolderVisit | undefined = saved
    ? {
        tree: {
          mode: saved.mode,
          mtimeMs: saved.mtimeMs,
          entries: new Map(saved.files.map((f) => [f.entry.path, f.entry])),
        },
        stamps: new Map(saved.files.map((f) => [f.entry.path, f.stamp])),
      }
    : undefined;
  const present = existsSync(binding.path);
  const rebuilding = join(dir, "rebuilding.json");
  if (!present) {
    write(rebuilding, { path: binding.path });
    ensureRealDirectory(binding.path);
  }
  const root = lstatSync(binding.path, { bigint: true });
  const rootId = [root.dev, root.ino].join(":");
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await store.head();
    if (!head || head.state !== "live" || !head.manifest)
      throw new Error(
        head?.state === "tombstone"
          ? "The assigned working folder was deleted in durable storage. The computer's files were preserved."
          : "The assigned working folder has not been published yet",
      );
    const remote =
      saved?.revision === head.revision && saved.manifest === head.manifest && before
        ? before.tree
        : await store.tree(head.manifest);
    validateLinks(remote);
    reconcileAliases(binding.path, previousAliases, aliases, remote);
    write(identity, { ...binding, grant: store.grant });
    const local = await visitFolder(binding.path, before, progress, remote, aliases, linkFor);
    validateLinks(local.tree);
    const replaced = existsSync(rebuilding) || Boolean(saved?.rootId && saved.rootId !== rootId);
    const next = mergeFolder(replaced ? undefined : before?.tree, local.tree, remote);
    validateLinks(next);
    let current = head;
    if (!equalTree(next, remote)) {
      await uploadChanged(store, binding.path, local, next, remote);
      const after = await visitFolder(binding.path, local, progress, undefined, aliases, linkFor);
      if (!equalTree(after.tree, local.tree))
        throw new Error("Working folder changed while a checkpoint was being prepared");
      const committed = await store.publish(next, head.revision);
      if (!committed) continue;
      current = committed;
    }
    await applyFolder(store, binding.path, local, next, linkFor);
    const final = await visitFolder(binding.path, local, progress, next, aliases, linkFor);
    if (!equalTree(final.tree, next))
      throw new Error(
        "Working folder changed while the durable checkout was arriving. Its current contents are retained.",
      );
    if (!current.manifest) throw new Error("Working folder head disappeared");
    write(snapshot, {
      version: 1,
      uri: binding.grant.baseUrl,
      guest: binding.grant.guestId,
      revision: current.revision,
      manifest: current.manifest,
      mode: next.mode,
      rootId,
      mtimeMs: next.mtimeMs,
      files: [...next.entries.values()].map((entry) => ({ entry, stamp: final.stamps.get(entry.path)! })),
    } satisfies SavedVisit);
    if (existsSync(rebuilding)) unlinkSync(rebuilding);
    return { revision: current.revision, manifest: current.manifest, changed: current.revision !== head.revision };
  }
  throw new Error("The durable working folder changed concurrently. Both copies were preserved.");
}
