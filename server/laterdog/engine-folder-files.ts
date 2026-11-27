import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  lchmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  link,
  utimes,
  lutimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, isAbsolute, relative, resolve } from "node:path";
import {
  compareWorkFolderPaths,
  safeWorkFolderLink,
  safeWorkFolderPath,
  materializedWorkFolderLink,
  WORK_FOLDER_BLOB_BYTES,
  type WorkFolderEntry,
} from "../../shared/work-folder-store.ts";
import { freeVolumeBytes, TRANSFER_SPACE_MARGIN } from "./volume-space.ts";
import { FolderStore, type FolderTreeReader, type FolderTree } from "./engine-folder-store.ts";

export interface FolderVisit {
  tree: FolderTree;
  stamps: Map<string, string>;
  rematerialize?: Set<string>;
}
type Stat = Awaited<ReturnType<typeof statPhysical>>;
const statPhysical = (path: string) => lstat(path, { bigint: true });
const stamp = (s: Stat) => [s.dev, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs].join(":");
const mode = (s: Stat) => Number(s.mode & 0o7777n);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
async function existing(path: string): Promise<Stat | null> {
  try {
    return await statPhysical(path);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

const mtime = (s: Stat) => Number(s.mtimeNs / 1000n) / 1000;
const sameTime = (left?: number, right?: number) =>
  left === undefined || right === undefined || Math.abs(left - right) < 0.002;
function fileTime(value: number): string | number {
  return value < 0 ? String(value / 1000) : value / 1000;
}

function recordedLink(
  path: string,
  target: string,
  folder: string,
  known?: WorkFolderEntry,
): Extract<WorkFolderEntry, { kind: "link" }> {
  if (
    known?.kind === "link" &&
    (known.target === target ||
      materializedWorkFolderLink(known) === target ||
      (known.scopedTarget === null &&
        resolve(dirname(join(folder, path)), target) === resolve(dirname(join(folder, path)), known.target)))
  )
    return { ...known };
  if (safeWorkFolderLink(path, target)) return { kind: "link", path, target };
  const alternative = isAbsolute(target) ? relative(dirname(join(folder, path)), resolve(target)) : target;
  return {
    kind: "link",
    path,
    target,
    scopedTarget: isAbsolute(target) && safeWorkFolderLink(path, alternative) ? alternative : null,
  };
}

export function sameFolderEntry(a?: WorkFolderEntry, b?: WorkFolderEntry): boolean {
  if (!a || !b) return a === b;
  if (!sameTime(a.mtimeMs, b.mtimeMs)) return false;
  if (a.kind === "dir" && b.kind === "dir") return a.mode === b.mode;
  if (a.kind === "link" && b.kind === "link")
    return (
      (a.mode === undefined || b.mode === undefined || a.mode === b.mode) &&
      a.target === b.target &&
      a.scopedTarget === b.scopedTarget
    );
  return (
    a.kind === "file" &&
    b.kind === "file" &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.sha256 === b.sha256 &&
    a.hardlink === b.hardlink
  );
}

async function diskPath(folder: string, name: string): Promise<string> {
  if (!safeWorkFolderPath(name)) throw new Error("Invalid working folder path");
  let path = folder;
  for (const part of [null, ...name.split("/").slice(0, -1)]) {
    if (part !== null) path = join(path, part);
    if (!(await statPhysical(path)).isDirectory()) throw new Error("Working folder ancestor is not a directory");
  }
  return join(folder, name);
}

async function scanFile(
  path: string,
  expected: Stat,
  store?: FolderStore,
  progress = () => {},
): Promise<{ sha256: string; contents: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    hash = createHash("sha256"),
    chunks: string[] = [];
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(expected))
      throw new Error("Working file changed before it could be read");
    const size = Number(expected.size);
    if (!Number.isSafeInteger(size)) throw new Error("Working file size cannot be represented");
    let pos = 0;
    const buffer = Buffer.allocUnsafe(Math.min(size, store ? WORK_FOLDER_BLOB_BYTES : 256 * 1024));
    while (pos < size) {
      const take = Math.min(buffer.length, size - pos);
      let filled = 0;
      while (filled < take) {
        const { bytesRead } = await handle.read(buffer, filled, take - filled, pos + filled);
        if (!bytesRead) throw new Error("Working file shortened while reading");
        filled += bytesRead;
      }
      const bytes = buffer.subarray(0, take);
      hash.update(bytes);
      progress();
      if (store) chunks.push(await store.put("blobs", bytes));
      pos += take;
    }
    if (
      stamp(await handle.stat({ bigint: true })) !== stamp(expected) ||
      stamp(await statPhysical(path)) !== stamp(expected)
    )
      throw new Error("Working file changed while reading");
    return { sha256: hash.digest("hex"), contents: store ? await store.pages("chunks", chunks) : "" };
  } finally {
    await handle.close();
  }
}

export async function visitFolder(
  folder: string,
  known?: FolderVisit,
  progress = () => {},
  reference?: FolderTree,
  aliases?: ReadonlyMap<string, string>,
  linkFor = materializedWorkFolderLink,
): Promise<FolderVisit> {
  const root = await statPhysical(folder);
  if (!root.isDirectory()) throw new Error("Working folder is not a physical directory");
  const rematerialize = new Set<string>();
  const hardlinks = new Map<string, Extract<WorkFolderEntry, { kind: "file" }>[]>();
  const stamps = new Map<string, string>(),
    entries = new Map<string, WorkFolderEntry>();
  async function walk(at: string): Promise<void> {
    const directory = at ? await diskPath(folder, at) : folder;
    const names = await readdir(directory, { encoding: "buffer" });
    for (const raw of names) {
      progress();
      const filename = raw.toString("utf8");
      if (!at && aliases?.has(filename)) {
        const path = join(folder, filename);
        if (!(await statPhysical(path)).isSymbolicLink() || (await readlink(path)) !== aliases.get(filename))
          throw new Error("Shared project alias changed while scanning " + filename);
        continue;
      }
      if (!Buffer.from(filename).equals(raw))
        throw new Error("The working folder has a filename that cannot be represented in UTF-8");
      const name = at ? at + "/" + filename : filename,
        path = await diskPath(folder, name),
        s = await statPhysical(path);
      let e: WorkFolderEntry;
      if (s.isDirectory()) {
        e = { path: name, kind: "dir", mode: mode(s) };
        await walk(name);
      } else if (s.isSymbolicLink()) {
        const bytes = await readlink(path, { encoding: "buffer" }),
          target = bytes.toString("utf8");
        if (!Buffer.from(target).equals(bytes)) throw new Error("Working folder link cannot be represented in UTF-8");
        e = recordedLink(name, target, folder, known?.tree.entries.get(name) ?? reference?.entries.get(name));
        if (process.platform !== "linux" || e.mode === undefined) e.mode = mode(s);
        if (target !== linkFor(e)) rematerialize.add(name);
      } else if (s.isFile()) {
        const cached = known?.tree.entries.get(name);
        const contents =
          cached?.kind === "file" && known?.stamps.get(name) === stamp(s)
            ? { sha256: cached.sha256, contents: cached.contents }
            : await scanFile(path, s, undefined, progress);
        e = { path: name, kind: "file", size: Number(s.size), mode: mode(s), ...contents };
        if (s.nlink > 1n) {
          const key = s.dev + ":" + s.ino,
            group = hardlinks.get(key);
          if (group) group.push(e);
          else hardlinks.set(key, [e]);
        }
      } else throw new Error("Unsupported special file in working folder: " + name);
      e.mtimeMs = mtime(s);
      entries.set(name, e);
      stamps.set(name, stamp(s));
    }
  }
  await walk("");
  for (const group of hardlinks.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => compareWorkFolderPaths(a.path, b.path));
    for (const member of group.slice(1)) member.hardlink = group[0].path;
  }
  return { tree: { mode: mode(root), mtimeMs: mtime(root), entries }, stamps, rematerialize };
}

export function validateFolderHardlinks(tree: FolderTree): void {
  for (const entry of tree.entries.values()) {
    if (entry.kind !== "file" || entry.hardlink === undefined) continue;
    const source = tree.entries.get(entry.hardlink);
    if (
      !safeWorkFolderPath(entry.hardlink) ||
      compareWorkFolderPaths(entry.hardlink, entry.path) >= 0 ||
      source?.kind !== "file" ||
      source.hardlink !== undefined ||
      source.sha256 !== entry.sha256 ||
      source.mode !== entry.mode ||
      source.size !== entry.size ||
      !sameTime(source.mtimeMs, entry.mtimeMs) ||
      (source.contents && entry.contents && source.contents !== entry.contents)
    ) {
      throw new Error("Working folder hard link does not match its assigned original file: " + entry.path);
    }
  }
}

export function mergeFolder(base: FolderTree | undefined, local: FolderTree, remote: FolderTree): FolderTree {
  const entries = new Map<string, WorkFolderEntry>();
  for (const key of new Set([...(base?.entries.keys() ?? []), ...local.entries.keys(), ...remote.entries.keys()])) {
    const before = base?.entries.get(key),
      a = local.entries.get(key),
      b = remote.entries.get(key);
    let chosen;
    if (a?.kind === "dir" && b?.kind === "dir" && a.mode === b.mode)
      chosen = { ...a, mtimeMs: Math.max(a.mtimeMs ?? -Infinity, b.mtimeMs ?? -Infinity) };
    else if (sameFolderEntry(a, b) || sameFolderEntry(a, before)) chosen = b;
    else if (sameFolderEntry(b, before)) chosen = a;
    else throw new Error("Working folder changed on both the computer and durable storage: " + key);
    if (chosen) {
      if (chosen.mtimeMs === -Infinity) delete chosen.mtimeMs;
      entries.set(key, chosen);
    }
  }
  for (const key of entries.keys()) {
    const slash = key.lastIndexOf("/");
    if (slash >= 0 && entries.get(key.slice(0, slash))?.kind !== "dir")
      throw new Error("Working folder has conflicting changes under " + key);
  }
  const prior = base?.mode;
  const resultMode =
    local.mode === remote.mode || local.mode === prior || prior === undefined
      ? remote.mode
      : remote.mode === prior
        ? local.mode
        : undefined;
  if (resultMode === undefined) throw new Error("Working folder permissions changed on both sides");
  const lm = local.mtimeMs,
    rm = remote.mtimeMs,
    bm = base?.mtimeMs;
  const resultTime = !base ? rm : sameTime(lm, bm) ? rm : sameTime(rm, bm) ? lm : Math.max(lm ?? 0, rm ?? 0);
  return { mode: resultMode, mtimeMs: resultTime, entries };
}

async function parallel<T>(values: T[], operation: (value: T) => Promise<void>): Promise<void> {
  let n = 0,
    failed: unknown;
  await Promise.all(
    Array.from({ length: Math.min(6, values.length) }, async () => {
      while (!failed && n < values.length) {
        const value = values[n++];
        try {
          await operation(value);
        } catch (e) {
          failed = e;
        }
      }
    }),
  );
  if (failed) throw failed;
}

export async function uploadChanged(
  store: FolderStore,
  folder: string,
  visit: FolderVisit,
  tree: FolderTree,
  remote: FolderTree,
  originalPaths?: ReadonlyMap<string, string>,
): Promise<void> {
  const changed = [...tree.entries.values()].filter((e) => e.kind === "file" && !e.contents);
  await parallel(changed, async (entry) => {
    if (entry.kind !== "file") return;
    const previous = remote.entries.get(entry.path);
    if (previous?.kind === "file" && previous.sha256 === entry.sha256 && previous.size === entry.size) {
      entry.contents = previous.contents;
      return;
    }
    const source = originalPaths?.get(entry.path) ?? entry.path;
    const path = await diskPath(folder, source),
      s = await statPhysical(path);
    if (visit.stamps.get(source) !== stamp(s))
      throw new Error("Working file changed before its checkpoint: " + entry.path);
    const scanned = await scanFile(path, s, store);
    if (scanned.sha256 !== entry.sha256) throw new Error("Working file changed during its checkpoint: " + entry.path);
    entry.contents = scanned.contents;
  });
}

export function equalTree(a: FolderTree, b: FolderTree): boolean {
  return (
    a.mode === b.mode &&
    sameTime(a.mtimeMs, b.mtimeMs) &&
    a.entries.size === b.entries.size &&
    [...a.entries].every(([k, e]) => sameFolderEntry(e, b.entries.get(k)))
  );
}

export async function applyFolder(
  store: FolderTreeReader,
  folder: string,
  local: FolderVisit,
  wanted: FolderTree,
  linkFor = materializedWorkFolderLink,
): Promise<void> {
  const changed = [...wanted.entries.values()].filter(
    (e) => local.rematerialize?.has(e.path) || !sameFolderEntry(e, local.tree.entries.get(e.path)),
  );
  const removed = [...local.tree.entries.values()].filter(
    (e) => !wanted.entries.has(e.path) || wanted.entries.get(e.path)?.kind !== e.kind,
  );
  if (
    !changed.length &&
    !removed.length &&
    local.tree.mode === wanted.mode &&
    sameTime(local.tree.mtimeMs, wanted.mtimeMs)
  )
    return;
  const required = changed.reduce((n, e) => n + (e.kind === "file" && !e.hardlink ? e.size : 0), 0);
  if (required > 0 && freeVolumeBytes(dirname(folder)) < required + TRANSFER_SPACE_MARGIN)
    throw new Error("The computer has insufficient free space for the working folder update");
  const staging = await mkdtemp(join(dirname(folder), ".laterdog-work-update-"));
  const material = new Map<string, string>();
  let changedOriginal = false;
  const movedInodes = new Set<string>();
  const inodeKey = (s: Stat) => s.dev + ":" + s.ino;
  const backups = new Map(
    [...removed, ...changed]
      .filter((e) => local.tree.entries.has(e.path))
      .map((e) => [e.path, "former-" + randomUUID()]),
  );
  try {
    await store.prefetchPages(changed.flatMap((e) => (e.kind === "file" && !e.hardlink ? [e.contents] : [])));
    await parallel(
      changed.filter((e) => e.kind !== "dir" && !(e.kind === "file" && e.hardlink)),
      async (e) => {
        const tmp = join(staging, randomUUID());
        if (e.kind === "link") {
          await symlink(linkFor(e), tmp);
          if (e.mtimeMs !== undefined) await lutimes(tmp, fileTime(e.mtimeMs), fileTime(e.mtimeMs));
        } else if (e.kind === "file") {
          const hash = createHash("sha256");
          let bytes = 0;
          const out = await open(tmp, "wx", 0o600);
          try {
            for await (const id of store.leaves(e.contents, "chunks")) {
              const chunk = await store.read("blobs", id as string);
              bytes += chunk.length;
              if (bytes > e.size || chunk.length === 0) throw new Error("Invalid working folder file length");
              hash.update(chunk);
              await out.writeFile(chunk);
            }
            if (bytes !== e.size || hash.digest("hex") !== e.sha256)
              throw new Error("Working folder file checksum mismatch");
            await out.chmod(e.mode);
            if (e.mtimeMs !== undefined) await out.utimes(fileTime(e.mtimeMs), fileTime(e.mtimeMs));
            await out.sync();
          } finally {
            await out.close();
          }
        }
        material.set(e.path, tmp);
      },
    );
    await writeFile(join(staging, "recovery.json"), JSON.stringify({ folder, backups: Object.fromEntries(backups) }), {
      mode: 0o600,
    });
    for (const e of removed.sort((a, b) => b.path.length - a.path.length)) {
      const path = await diskPath(folder, e.path),
        s = await statPhysical(path);
      if (e.kind === "dir") {
        if (!s.isDirectory() || mode(s) !== e.mode)
          throw new Error("Working folder directory changed during checkout: " + e.path);
        await rmdir(path);
        changedOriginal = true;
      } else {
        const tmp = join(staging, backups.get(e.path)!);
        await rename(path, tmp);
        movedInodes.add(inodeKey(s));
        changedOriginal = true;
        const moved = await statPhysical(tmp);
        if (
          !local.stamps
            .get(e.path)
            ?.startsWith([moved.dev, moved.ino, moved.size, moved.mode, moved.mtimeNs].join(":") + ":")
        ) {
          try {
            await link(tmp, path);
          } catch {}
          throw new Error("Working file changed during removal: " + e.path);
        }
      }
    }
    for (const e of changed.filter((e) => e.kind === "dir").sort((a, b) => a.path.length - b.path.length)) {
      const path = await diskPath(folder, e.path),
        s = await existing(path);
      if (!s) await mkdir(path, { mode: 0o700 });
      else if (!s.isDirectory() || local.tree.entries.get(e.path)?.kind !== "dir")
        throw new Error("Unexpected working folder directory: " + e.path);
    }
    async function install(e: WorkFolderEntry, path: string) {
      if (e.kind === "link") {
        await symlink(linkFor(e), path);
        if (process.platform === "darwin" && e.mode !== undefined) await lchmod(path, e.mode);
        if (e.mtimeMs !== undefined) await lutimes(path, fileTime(e.mtimeMs), fileTime(e.mtimeMs));
      } else if (e.kind === "file" && e.hardlink) {
        const src = material.get(e.hardlink) ?? (await diskPath(folder, e.hardlink));
        const current = await statPhysical(src);
        if (
          !current.isFile() ||
          Number(current.size) !== e.size ||
          mode(current) !== e.mode ||
          !sameTime(mtime(current), e.mtimeMs)
        )
          throw new Error("Working folder hard link source changed during checkout: " + e.hardlink);
        await link(src, path);
        movedInodes.add(inodeKey(current));
      } else await link(material.get(e.path)!, path);
    }
    for (const e of changed
      .filter((e) => e.kind !== "dir")
      .sort((a, b) => Number(a.kind === "file" && !!a.hardlink) - Number(b.kind === "file" && !!b.hardlink))) {
      const path = await diskPath(folder, e.path),
        s = await existing(path);
      if (s) {
        const expected = local.stamps.get(e.path),
          current = stamp(s);
        if (
          expected !== current &&
          !(
            movedInodes.has(inodeKey(s)) &&
            expected?.slice(0, expected.lastIndexOf(":")) === current.slice(0, current.lastIndexOf(":"))
          )
        )
          throw new Error("Working file changed during checkout: " + e.path);
        const backup = join(staging, backups.get(e.path)!);
        await rename(path, backup);
        movedInodes.add(inodeKey(s));
        changedOriginal = true;
        const moved = await statPhysical(backup);
        if (moved.dev !== s.dev || moved.ino !== s.ino || moved.size !== s.size || moved.mtimeNs !== s.mtimeNs) {
          try {
            await link(backup, path);
          } catch {}
          throw new Error("Working file changed during replacement: " + e.path);
        }
        try {
          await install(e, path);
        } catch (error) {
          try {
            await link(backup, path);
          } catch {}
          throw error;
        }
      } else await install(e, path);
    }
    const affectedDirs = new Set<string>();
    for (const e of [...changed, ...removed]) {
      let name = e.path;
      while (name.includes("/")) {
        name = name.slice(0, name.lastIndexOf("/"));
        affectedDirs.add(name);
      }
      if (e.kind === "dir") affectedDirs.add(e.path);
    }
    for (const name of [...affectedDirs].sort((a, b) => b.length - a.length)) {
      const e = wanted.entries.get(name);
      if (e?.kind !== "dir") continue;
      const path = await diskPath(folder, name);
      await chmod(path, e.mode);
      if (e.mtimeMs !== undefined) await utimes(path, fileTime(e.mtimeMs), fileTime(e.mtimeMs));
    }
    if (local.tree.mode !== wanted.mode) await chmod(folder, wanted.mode);
    if (wanted.mtimeMs !== undefined) await utimes(folder, fileTime(wanted.mtimeMs), fileTime(wanted.mtimeMs));
  } catch (e) {
    if (changedOriginal)
      throw new Error((e as Error).message + ". Prior working files were retained in " + staging, { cause: e });
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
  await rm(staging, { recursive: true, force: true });
}

export async function publishInitialWorkFolder(folder: string, store: FolderStore) {
  const visit = await visitFolder(folder);
  await uploadChanged(store, folder, visit, visit.tree, { mode: visit.tree.mode, entries: new Map() });
  const after = await visitFolder(folder, visit);
  if (!equalTree(visit.tree, after.tree))
    throw new Error("The working folder changed while preparing its first durable version");
  const head = await store.publish(visit.tree, null);
  if (!head) throw new Error("Another writer has already published this working folder");
  return head;
}
