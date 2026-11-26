import { createHash } from "node:crypto";
import { posix } from "node:path";
import { compareWorkFolderPaths, type WorkFolderEntry, type WorkFolderHead, type WorkFolderNode, type WorkFolderPageInfo } from "../../shared/work-folder-store.ts";
import { folderError } from "./work-folder-namespace.ts";
import type { FsReply, FsRequest } from "./work-folder-guest-fs.ts";

type Range = WorkFolderPageInfo & {hash: string};
type Leaf = { item: WorkFolderEntry; revision: string };

export class DurableFolderRead {
  private metadata = new Map<string, Promise<WorkFolderNode>>();
  constructor(private base: string, private token: string, private uid: number, private gid: number) {}
  private async get(path: string) {
    return fetch(this.base + path, { headers: { authorization: "Bearer " + this.token }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  }
  private async bytes(kind: string, hash: string) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw folderError("EIO");
    const response = await this.get("/" + kind + "/" + hash);
    if (!response.ok) throw folderError("EIO");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw folderError("EIO");
    return bytes;
  }
  private page(hash: string): Promise<WorkFolderNode> {
    const prior = this.metadata.get(hash);
    if (prior) return prior;
    const lookup = this.bytes("manifests", hash).then(bytes => JSON.parse(bytes.toString("utf8")) as WorkFolderNode);
    this.metadata.set(hash, lookup);
    if (this.metadata.size > 128) this.metadata.delete(this.metadata.keys().next().value!);
    void lookup.catch(() => this.metadata.delete(hash));
    return lookup;
  }
  private async ranges(hash: string): Promise<Range[]> {
    const response = await this.get("/ranges/" + hash);
    if (!response.ok) throw folderError("EIO");
    const detail = await response.json() as {children:Range[]};
    return detail.children;
  }
  private async *entries(hash: string, start: string, end: string | null, depth = 0, directPrefix?: string): AsyncGenerator<WorkFolderEntry> {
    if (depth > 32) throw folderError("EIO");
    const node = await this.page(hash);
    if (node.kind === "entries") {
      for (const entry of node.entries) {
        if (compareWorkFolderPaths(entry.path, start) >= 0 && (end === null || compareWorkFolderPaths(entry.path, end) < 0)) yield entry;
      }
    } else if (node.kind === "pages" && node.of === "entries") {
      for (const child of await this.ranges(hash)) {
        if (child.last !== undefined && compareWorkFolderPaths(child.last, start) < 0) continue;
        if (end !== null && child.first !== undefined && compareWorkFolderPaths(child.first, end) >= 0) break;
        if (directPrefix !== undefined && child.first?.startsWith(directPrefix) && child.last) {
          const nested = child.first.indexOf("/", directPrefix.length);
          if (nested !== -1 && child.last.startsWith(child.first.slice(0, nested + 1))) continue;
        }
        yield* this.entries(child.hash, start, end, depth + 1, directPrefix);
      }
    } else throw folderError("EIO");
  }
  private async root(manifest: string) {
    const root = await this.page(manifest);
    if (root.kind !== "root") throw folderError("EIO");
    return root;
  }
  private async head(): Promise<WorkFolderHead | null> {
    const response = await this.get("/head");
    if (response.status === 404) return null;
    if (!response.ok) throw folderError("EIO");
    return await response.json() as WorkFolderHead;
  }
  async lookup(path: string): Promise<Leaf> {
    const head = await this.head();
    if (!head?.manifest) {
      if (path) throw folderError("ENOENT");
      return { revision: "", item: { kind: "dir", path, mode: 0o700 } };
    }
    const root = await this.root(head.manifest);
    if (!path) return { revision: head.manifest, item: { kind: "dir", path, mode: root.mode, mtimeMs: root.mtimeMs } };
    for await (const item of this.entries(root.entries, path, path + "\0")) {
      if (item.path === path) return { item, revision: head.manifest };
    }
    throw folderError("ENOENT");
  }
  attr(entry: WorkFolderEntry) {
    const ts = String(BigInt(Math.floor(entry.mtimeMs ?? 0)) * 1_000_000n);
    const type = entry.kind === "dir" ? 0o40000 : entry.kind === "link" ? 0o120000 : 0o100000;
    const size = entry.kind === "file" ? entry.size : entry.kind === "link" ? Buffer.byteLength(entry.target) : 4096;
    const ino = BigInt("0x" + createHash("sha256").update(this.base + "\0" + entry.path).digest("hex").slice(0,15)) + 2n;
    return { ino: String(ino), mode: type | (entry.kind === "link" ? 0o777 : entry.mode & 0o777), nlink: 1, size: String(size), blocks: String(Math.ceil(size / 512)), uid:this.uid, gid:this.gid, atimeNs:ts, mtimeNs:ts, ctimeNs:ts };
  }
  async directory(leaf: Leaf, cursor: unknown): Promise<FsReply> {
    if (leaf.item.kind !== "dir") throw folderError("ENOTDIR");
    const prefix = leaf.item.path ? leaf.item.path + "/" : "";
    const start = cursor ? String(cursor) : prefix;
    if (!start.startsWith(prefix)) throw folderError("EINVAL");
    if (!leaf.revision) return { ok: true, entries: [] };
    const root = await this.root(leaf.revision);
    const entries = [];
    for await (const entry of this.entries(root.entries, start, prefix ? prefix.slice(0, -1) + "0" : null, 0, prefix)) {
      const name = entry.path.slice(prefix.length);
      if (!name || name.includes("/")) continue;
      if (entries.length === 64) return { ok: true, entries, next: entry.path };
      const { mode, ino } = this.attr(entry);
      entries.push({ name, mode, ino });
    }
    return { ok: true, entries };
  }
  private async readChunks(hash: string, offset: number, size: number, depth = 0): Promise<Buffer> {
    if (depth > 32) throw folderError("EIO");
    const node = await this.page(hash);
    const parts: Buffer[] = [];
    if (node.kind === "pages" && node.of === "chunks") {
      for (const child of await this.ranges(hash)) {
        if (!size) break;
        if (offset >= child.bytes) { offset -= child.bytes; continue; }
        const wanted = Math.min(size, child.bytes - offset);
        const part = await this.readChunks(child.hash, offset, wanted, depth + 1);
        if (part.length !== wanted) throw folderError("EIO");
        parts.push(part); size -= wanted; offset = 0;
      }
    } else if (node.kind === "chunks") {
      for (const piece of node.hashes) {
        if (!size) break;
        const meta = await fetch(this.base + "/blobs/" + piece, { method: "HEAD", headers: { authorization: "Bearer " + this.token }, redirect: "error", signal: AbortSignal.timeout(30_000) });
        const length = Number(meta.headers.get("content-length"));
        if (!meta.ok || !Number.isSafeInteger(length) || length < 0) throw folderError("EIO");
        if (offset >= length) { offset -= length; continue; }
        const part = (await this.bytes("blobs", piece)).subarray(offset, offset + size);
        parts.push(part); size -= part.length; offset = 0;
      }
    } else throw folderError("EIO");
    return Buffer.concat(parts);
  }
  async operate(leaf: Leaf, request: FsRequest): Promise<FsReply> {
    if (request.op === "getattr") return { ok: true, attr: this.attr(leaf.item) };
    if (request.op === "readlink") {
      if (leaf.item.kind !== "link") throw folderError("EINVAL");
      return { ok: true, target: leaf.item.scopedTarget === null ? posix.basename(leaf.item.path) : leaf.item.scopedTarget ?? leaf.item.target };
    }
    if (request.op === "readdir") return this.directory(leaf, request.cursor);
    if (request.op === "read") {
      if (leaf.item.kind !== "file") throw folderError("EISDIR");
      const from = Number(request.offset ?? 0), length = Number(request.size);
      if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(length) || length < 0 || length > 128 * 1024) throw folderError("EINVAL");
      const want = Math.min(length, Math.max(0, leaf.item.size - from));
      const bytes = want ? await this.readChunks(leaf.item.contents, from, want) : Buffer.alloc(0);
      if (bytes.length !== want) throw folderError("EIO");
      return { ok: true, data: bytes.toString("base64") };
    }
    if (["release","releasedir","flush","fsync"].includes(request.op)) return { ok: true };
    throw folderError("EROFS");
  }
}
