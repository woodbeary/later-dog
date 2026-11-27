import { createHash, randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { posix } from "node:path";
import type { DurableFolderRead } from "./work-folder-durable-read.ts";
import { safeWorkFolderPath } from "../../shared/work-folder-store.ts";
import type { FsReply, FsRequest, GuestFolderAccess } from "./work-folder-guest-fs.ts";
import type { FolderScope } from "./work-folder-locations.ts";
import { directoryAttr, folderError, WorkFolderNamespace } from "./work-folder-namespace.ts";

type Channel = { scope: FolderScope; access: Promise<GuestFolderAccess>; handles: number; writers: number; active: number; timer?: NodeJS.Timeout; dirty: number; saved: number; saving?: Promise<void> };
type ColdCursor = { view: DurableFolderRead; leaf: Awaited<ReturnType<DurableFolderRead["lookup"]>> };
type Cursor = ColdCursor | { names: string[]; path: string } | { remote: string; channel: Channel; path: string; writable: boolean };
export const IDLE_CHANNEL_KEPT_MS = 10 * 60_000;
const changed = new Set(["write", "mkdir", "create", "unlink", "rmdir", "rename", "link", "symlink", "setattr"]);

export class WorkFolderMountRouter {
  private channels = new Map<string, Channel>();
  private handles = new Map<string, Cursor>();
  private mutations = 0;
  private rootChanges = new Set<string>();
  private scopeOperations = new Map<string, number>();
  private readonly makeRoot?: (scope: FolderScope, mode: number) => Promise<void>;
  private checkpointing = false;
  private reloading = false;
  private operations = 0;
  private readonly names: WorkFolderNamespace;
  private readonly open: (scope: FolderScope) => Promise<GuestFolderAccess>;
  private readonly remove: (scope: FolderScope) => Promise<void>;
  private readonly uid: number;
  private readonly gid: number;
  private readonly report: (message: string) => void;
  private readonly coldView?: (scope: FolderScope) => Promise<DurableFolderRead | null>;
  private readonly projectedLink?: (scope: FolderScope, inside: string, target: string) => string | null;
  constructor(
    names: WorkFolderMountRouter["names"],
    open: WorkFolderMountRouter["open"],
    remove: WorkFolderMountRouter["remove"],
    uid: WorkFolderMountRouter["uid"],
    gid: WorkFolderMountRouter["gid"],
    report: WorkFolderMountRouter["report"],
    coldView?: WorkFolderMountRouter["coldView"],
    projectedLink?: WorkFolderMountRouter["projectedLink"],
    makeRoot?: WorkFolderMountRouter["makeRoot"],
  ) {
    this.names = names;
    this.open = open;
    this.remove = remove;
    this.uid = uid;
    this.gid = gid;
    this.report = report;
    this.coldView = coldView;
    this.projectedLink = projectedLink;
    this.makeRoot = makeRoot;
  }
  private attr(path: string) { return directoryAttr(this.names.resolve(path)?.scope.path ?? path, this.uid, this.gid); }
  private readlink(scope: FolderScope, path: string, target: string, local?: string | null): FsReply {
    const projected = this.projectedLink?.(scope, path, target);
    if (projected) return { ok: true, target: projected, projected: true };
    const value = local === undefined ? target : local;
    if (value && !posix.isAbsolute(value)) {
      const end = posix.normalize(posix.join(posix.dirname(path), value));
      if (end !== ".." && !end.startsWith("../")) return { ok: true, target: value };
    }
    return { ok: true, target: posix.basename(path) };
  }
  private virtual(request: FsRequest, names: string[]): FsReply {
    if (request.op === "getattr") return { ok: true, attr: this.attr(request.path) };
    if (request.op === "opendir") {
      const handle = randomUUID();
      this.handles.set(handle, { path: request.path, names: names.sort() });
      return { ok: true, attr: this.attr(request.path), handle };
    }
    throw folderError(request.op === "open" ? "EISDIR" : "EPERM");
  }
  private getChannel(scope: FolderScope): Channel {
    let channel = this.channels.get(scope.path);
    if (!channel) {
      const next: Channel = { scope, handles: 0, writers: 0, active: 0, dirty: 0, saved: 0, access: this.open(scope) };
      this.channels.set(scope.path, next);
      void next.access.catch(() => { if (this.channels.get(scope.path) === next) this.channels.delete(scope.path); });
      channel = next;
    }
    clearTimeout(channel.timer);
    delete channel.timer;
    return channel;
  }
  private async save(channel: Channel): Promise<void> {
    const target = channel.dirty;
    while (channel.saved < target) {
      if (!channel.saving) {
        const generation = channel.dirty;
        channel.saving = channel.access.then(access => access.checkpoint())
          .then(() => { channel.saved = generation; })
          .finally(() => { delete channel.saving; });
      }
      await channel.saving;
    }
  }
  private idle(channel: Channel): void {
    if (channel.active || channel.timer) return;
    channel.timer = setTimeout(async () => {
      delete channel.timer;
      try {
        await this.save(channel);
        if (!channel.handles && !channel.active && channel.saved === channel.dirty && this.channels.get(channel.scope.path) === channel && !channel.timer) {
          channel.timer = setTimeout(() => {
            delete channel.timer;
            if (channel.handles || channel.active || channel.saved !== channel.dirty || this.channels.get(channel.scope.path) !== channel) return;
            this.channels.delete(channel.scope.path);
            void channel.access.then((access) => access.channel.close(), () => {});
          }, IDLE_CHANNEL_KEPT_MS);
          channel.timer.unref();
        }
      } catch (error) {
        this.report("Work folder checkpoint pending: " + String(error));
      } finally {
        if (this.channels.get(channel.scope.path) === channel && channel.dirty !== channel.saved) this.idle(channel);
      }
    }, 5_000);
    channel.timer.unref();
  }
  private guestAttrs(reply: FsReply, scope: FolderScope, inside: string) {
    const remap = (ino: string) => String(BigInt("0x" + createHash("sha256").update(scope.path + "\0" + ino).digest("hex").slice(0, 15)) + 2n);
    if (reply.attr && typeof reply.attr === "object" && "ino" in reply.attr) {
      reply.attr = { ...reply.attr, ino: inside ? remap(String(reply.attr.ino)) : directoryAttr(scope.path, this.uid, this.gid).ino, uid: this.uid, gid: this.gid };
    }
    if (Array.isArray(reply.entries)) reply.entries = reply.entries.map(e => ({ ...e, ino: remap(String(e.ino)) }));
    return reply;
  }
  async checkpoint(): Promise<void> {
    if (this.reloading || this.checkpointing || this.mutations || [...this.channels.values()].some(channel => channel.writers)) throw folderError("EBUSY");
    this.checkpointing = true;
    try {
      await Promise.all([...this.channels.values()].map(channel => this.save(channel)));
    } finally { this.checkpointing = false; }
  }
  async reload(): Promise<void> {
    if (this.checkpointing || this.reloading || this.operations || this.handles.size) throw folderError("EBUSY");
    this.reloading = true;
    try {
      await this.close();
      this.names.reload();
    } finally { this.reloading = false; }
  }
  async dispatch(request: FsRequest): Promise<FsReply> {
    const writing = changed.has(request.op) || request.op === "open" && Boolean(Number(request.flags) & (3 | 512));
    if (this.reloading || writing && this.checkpointing) throw folderError("EBUSY");
    const scopeRoot = (path?: string) => {
      if (!path) return "";
      const parts = path.split("/");
      if (parts[0] === "dogs" && parts.length >= 2) return parts.slice(0, 2).join("/");
      if (parts[0] === "tasks" && parts.length >= 3) return parts.slice(0, 3).join("/");
      return "";
    };
    const roots = new Set([request.path, request.newPath, request.source].map(scopeRoot).filter(Boolean));
    const rootChange = roots.has(request.path) && (request.op === "mkdir" || request.op === "rmdir");
    if ([...roots].some(root => this.rootChanges.has(root)) || rootChange && this.scopeOperations.has(request.path)) throw folderError("EBUSY");
    if (rootChange) this.rootChanges.add(request.path);
    for (const root of roots) this.scopeOperations.set(root, (this.scopeOperations.get(root) ?? 0) + 1);
    if (writing) this.mutations++;
    this.operations++;
    try { return await this.operate(request); }
    finally {
      if (rootChange) this.rootChanges.delete(request.path);
      for (const root of roots) {
        const count = this.scopeOperations.get(root)! - 1;
        if (count) this.scopeOperations.set(root, count);
        else this.scopeOperations.delete(root);
      }
      this.operations--;
      if (writing) this.mutations--;
    }
  }
  private async operate(request: FsRequest): Promise<FsReply> {
    if (request.root !== "work-folders" || typeof request.path !== "string" || (request.path && !safeWorkFolderPath(request.path))) throw folderError("EINVAL");
    const cursor = request.handle ? this.handles.get(request.handle) : undefined;
    if (request.handle && !cursor) throw folderError("EBADF");
    if (request.op === "statfs" && !this.names.resolve(request.path)) {
      const fs = await statfs(this.names.dataDir, { bigint: true });
      return { ok: true, space: { blocks: String(fs.blocks), bfree: String(fs.bfree), bavail: String(fs.bavail), files: String(fs.files), ffree: String(fs.ffree), bsize: Number(fs.bsize), frsize: Number(fs.bsize), namelen: 255 } };
    }
    if (cursor && "view" in cursor) {
      if (request.op === "release" || request.op === "releasedir") this.handles.delete(request.handle!);
      return cursor.view.operate(cursor.leaf, request);
    }
    if (cursor && "names" in cursor) {
      if (request.op === "releasedir") { this.handles.delete(request.handle!); return { ok: true }; }
      if (request.op === "fsync" || request.op === "flush") return { ok: true };
      if (request.op !== "readdir") throw folderError("EBADF");
      const index = Number(request.cursor ?? 0);
      if (!Number.isSafeInteger(index) || index < 0 || index > cursor.names.length) throw folderError("EINVAL");
      const entries = cursor.names.slice(index, index + 64).map(name => ({ name, ...this.attr(posix.join(cursor.path, name)) }));
      return { ok: true, entries, ...(index + entries.length < cursor.names.length ? { next: String(index + entries.length) } : {}) };
    }
    const names = this.names.list(request.path);
    if (names && request.op === "mkdir") throw folderError("EEXIST");
    if (names && !(request.op === "rmdir" && request.path.startsWith("tasks/"))) return this.virtual(request, names);
    const location = this.names.resolve(request.path);
    if (!location && !cursor) {
      if (request.op === "mkdir" || request.op === "rmdir") {
        const scope = request.op === "mkdir" ? this.names.newRoot(request.path) : null;
        if (scope) await this.makeRoot?.(scope, Number(request.mode ?? 0o700) & 0o7777);
        this.names.update(request.path, request.op === "mkdir");
        return { ok: true, attr: this.attr(request.path) };
      }
      throw folderError("ENOENT");
    }
    const handle = cursor && "remote" in cursor ? cursor : undefined;
    const scope = handle?.channel.scope ?? location!.scope;
    const inside = handle?.path ?? location!.inside;
    if (!inside && request.op === "mkdir") throw folderError("EEXIST");
    const cloned: FsRequest = { ...request, op: request.op === "readlink" ? "readlinkMetadata" : request.op, path: inside, root: scope.id, ...(handle ? { handle: handle.remote } : {}) };
    for (const field of ["newPath", "source"] as const) {
      if (request[field] === undefined) continue;
      const other = this.names.resolve(request[field]!);
      if (!other || other.scope.path !== scope.path) throw folderError("EXDEV");
      cloned[field] = other.inside;
    }
    if (!handle && !this.channels.has(scope.path) &&
        (["getattr", "readlink", "opendir"].includes(request.op) || request.op === "open" && (Number(request.flags ?? 0) & (3 | 64 | 512)) === 0)) {
      const view = await this.coldView?.(scope);
      if (view) {
        const leaf = await view.lookup(inside);
        if (!inside && request.op === "getattr") return { ok: true, attr: { ...view.attr(leaf.item), ino: this.attr(request.path).ino } };
        if (request.op === "readlink" && leaf.item.kind === "link") return this.readlink(scope, inside, leaf.item.target, leaf.item.scopedTarget);
        if (request.op === "open" || request.op === "opendir") {
          if (request.op === "open" && leaf.item.kind !== "file") throw folderError(leaf.item.kind === "link" ? "ELOOP" : "EISDIR");
          if (request.op === "opendir" && leaf.item.kind !== "dir") throw folderError("ENOTDIR");
          const id = randomUUID();
          this.handles.set(id, { view, leaf });
          return { ok: true, handle: id, attr: view.attr(leaf.item) };
        }
        return view.operate(leaf, request);
      }
    }
    if (!inside && request.op === "rmdir" && !handle) {
      if (!this.names.isFolderRoot(request.path)) throw folderError("EBUSY");
      const live = this.channels.get(scope.path);
      if (live && (live.active || live.handles)) throw folderError("EBUSY");
      if (live) await this.save(live);
      await this.remove(scope);
      if (live) {
        clearTimeout(live.timer);
        (await live.access).channel.close();
        this.channels.delete(scope.path);
      }
      this.names.update(request.path, false);
      return { ok: true };
    }
    const channel = handle?.channel ?? this.getChannel(scope);
    clearTimeout(channel.timer);
    delete channel.timer;
    channel.active++;
    try {
      const access = await channel.access;
      if (access.channel.closed) throw folderError("EIO");
      const reply = await access.channel.call(cloned);
      if (!reply.ok) return reply;
      if (request.op === "readlink") {
        if (typeof reply.target !== "string") throw folderError("EIO");
        return this.readlink(scope, inside, reply.target);
      }
      if (changed.has(request.op) || (request.op === "open" && (Number(request.flags) & 512))) channel.dirty++;
      if (reply.handle) {
        const id = randomUUID();
        const writable = request.op === "create" || request.op === "open" && Boolean(Number(request.flags) & 3);
        this.handles.set(id, { remote: reply.handle, channel, path: inside, writable });
        if (writable) channel.writers++;
        channel.handles++;
        reply.handle = id;
      }
      if (request.op === "fsync") await this.save(channel);
      return this.guestAttrs(reply, scope, inside);
    } finally {
      if (handle && (request.op === "release" || request.op === "releasedir") && this.handles.delete(request.handle!)) {
        channel.handles--;
        if (handle.writable) channel.writers--;
      }
      channel.active--;
      this.idle(channel);
    }
  }
  async close(): Promise<void> {
    const all = [...this.channels.values()];
    await Promise.all(all.map(channel => this.save(channel)));
    for (const channel of all) { clearTimeout(channel.timer); (await channel.access).channel.close(); }
    this.channels.clear();
    this.handles.clear();
  }
}
