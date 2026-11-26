import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { z } from "zod";
import { workFolderLayoutSchema, type WorkFolderLayout } from "../../shared/work-folder-layout.ts";
import {
  WORK_FOLDER_BLOB_BYTES,
  validWorkFolderScope,
  workFolderAuthority,
  workFolderBaseUrl,
  type WorkFolderHead,
  type WorkFolderNode,
} from "../../shared/work-folder-store.ts";
import { FolderTreeReader, folderHash } from "./engine-folder-store.ts";
import { projectFolderId } from "./work-folder-locations.ts";

const hashId = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const catalogSchema = z
  .object({
    layout: workFolderLayoutSchema,
    folders: z
      .array(
        z
          .object({ owner: identifier, id: identifier, revision: hashId.nullable(), manifest: hashId.nullable() })
          .strict(),
      )
      .max(100_000),
  })
  .strict();
type Catalog = z.infer<typeof catalogSchema>;
export type PortableScope = Pick<Catalog["folders"][number], "owner" | "id">;
export type ObjectKind = "blobs" | "manifests";
export type PortableAuthority = { origin: string; bootstrap: string };
export type BackupFolderAccess = PortableScope & { url: string; token: string };
const magic = Buffer.from("LATERDOG-FOLDERS-1\n");
const metadataBytes = 16 * 1024 * 1024;
const prefixBytes = 1 + 4 + 32 + 12;
const maxObjects = 1_000_000;
const codes = { manifests: 1, blobs: 2, catalog: 3 } as const;
type RecordKind = keyof typeof codes;
type Stored = { offset: number; size: number };
export type FolderTotals = { files: number; directories: number; bytes: number };
export function emptyFolderTotals(): FolderTotals {
  return { files: 0, directories: 0, bytes: 0 };
}
export async function countAssignedFolder(
  reader: FolderTreeReader,
  manifest: string,
  totals: FolderTotals,
  limit: { bytes: number; entries: number },
) {
  const tree = await reader.tree(manifest);
  totals.directories++;
  for (const entry of tree.entries.values()) {
    if (entry.kind === "dir") totals.directories++;
    else {
      totals.files++;
      if (entry.kind === "file") totals.bytes += entry.size;
    }
  }
  if (totals.bytes > limit.bytes || totals.files + totals.directories > limit.entries)
    throw new Error("Assigned work folders exceed the portable backup size or file limit.");
}
type ReadObject = (kind: ObjectKind, hash: string) => Promise<Buffer>;

export async function checkpointAssignedFolders(socketPath: string | undefined) {
  if (!socketPath) throw new Error("The mounted work folder checkpoint service is unavailable.");
  await new Promise<void>((resolve, reject) => {
    const call = request({ socketPath, method: "POST", path: "/v1/checkpoint" }, (response) => {
      response.resume();
      response.once("error", reject);
      response.once("end", () => {
        if (response.statusCode === 200) resolve();
        else
          reject(
            Object.assign(new Error("Could not checkpoint working folders. Finish open file writes and try again."), {
              status: response.statusCode ?? 503,
            }),
          );
      });
    });
    call.once("error", reject);
    call.end();
  });
}

export function portableFolderScopes(layout: WorkFolderLayout): PortableScope[] {
  const folders: PortableScope[] = [];
  for (const owner of layout.dogs) folders.push({ owner, id: "dog" });
  for (const [owner, threads] of Object.entries(layout.tasks))
    for (const thread of threads) folders.push({ owner, id: "task-" + thread });
  for (const project of layout.projects) folders.push({ owner: project.owner, id: projectFolderId(project.path) });
  if (layout.loose) folders.push({ owner: layout.loose.owner, id: "loose" });
  const unique = new Set<string>();
  for (const f of folders) {
    const key = f.owner + "/" + f.id;
    if (!validWorkFolderScope(f.owner, f.id) || unique.has(key))
      throw new Error("Invalid or duplicate portable working folder.");
    unique.add(key);
  }
  return folders;
}

export function currentBackupLayout(dataDir: string, initial: WorkFolderLayout): WorkFolderLayout {
  const names = join(dataDir, "work-folder-names.json");
  if (!existsSync(names)) return initial;
  const saved = JSON.parse(readFileSync(names, "utf8"));
  return workFolderLayoutSchema.parse({ ...initial, dogs: saved.dogs, tasks: saved.tasks });
}

export async function backupFolderAccess(
  authority: PortableAuthority,
  scope: PortableScope,
): Promise<BackupFolderAccess> {
  return {
    ...scope,
    url: workFolderBaseUrl(authority.origin, scope.owner, scope.id),
    token: await workFolderAuthority(authority.bootstrap, scope.owner, scope.id),
  };
}

export class BackupFolderStore extends FolderTreeReader {
  private readonly access: BackupFolderAccess;
  constructor(access: BackupFolderAccess) {
    super();
    this.access = access;
  }
  async request(path: string, method = "GET", body?: Buffer | string) {
    const response = await fetch(this.access.url + path, {
      method,
      redirect: "error",
      headers: {
        authorization: "Bearer " + this.access.token,
        ...(body ? { "content-type": typeof body === "string" ? "application/json" : "application/octet-stream" } : {}),
      },
      ...(body !== undefined ? { body: body as RequestInit["body"] } : {}),
      signal: AbortSignal.timeout(90_000),
    });
    if (response.status === 404 && path === "/head") {
      const problem = (await response
        .clone()
        .json()
        .catch(() => null)) as { error?: string } | null;
      if (problem?.error === "never_published") return response;
    }
    if (!response.ok)
      throw Object.assign(
        new Error("Working folder storage returned " + response.status + " during backup or restore."),
        { status: response.status },
      );
    return response;
  }
  async head(): Promise<WorkFolderHead | null> {
    const response = await this.request("/head");
    if (response.status === 404) return null;
    const value = (await response.json()) as WorkFolderHead;
    if (
      !hashId.safeParse(value.revision).success ||
      !(
        (value.manifest === null && value.state === "tombstone") ||
        (hashId.safeParse(value.manifest).success && value.state === "live")
      )
    )
      throw new Error("Invalid working folder revision.");
    return value;
  }
  async read(kind: ObjectKind, hash: string) {
    hashId.parse(hash);
    const response = await this.request("/" + kind + "/" + hash);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > WORK_FOLDER_BLOB_BYTES || folderHash(bytes) !== hash)
      throw new Error("Working folder object failed its checksum.");
    return bytes;
  }
  async put(kind: ObjectKind, hash: string, bytes: Buffer) {
    if (folderHash(bytes) !== hash) throw new Error("Damaged working folder object.");
    await this.request("/" + kind + "/" + hash, "PUT", bytes);
  }
  async commit(parent: string | null, manifest: string | null): Promise<string> {
    const response = await this.request("/commit", "POST", JSON.stringify({ parent, manifest }));
    const head = (await response.json()) as WorkFolderHead;
    if (!hashId.safeParse(head.revision).success || head.manifest !== manifest)
      throw new Error("Missing working folder restore receipt.");
    return head.revision;
  }
}

export async function walkFolderObjects(
  root: string,
  read: ReadObject,
  take: (kind: ObjectKind, hash: string, bytes: Buffer) => Promise<void>,
  seen = new Set<string>(),
) {
  async function visit(kind: ObjectKind, hash: string, depth: number): Promise<void> {
    if (depth > 100 || !hashId.safeParse(hash).success) throw new Error("Invalid working folder object graph.");
    const key = kind + "/" + hash;
    if (seen.has(key)) return;
    if (seen.size >= maxObjects) throw new Error("Too many working folder objects for one portable backup.");
    const bytes = await read(kind, hash);
    if (folderHash(bytes) !== hash) throw new Error("Damaged working folder object.");
    if (kind === "manifests") {
      const node = JSON.parse(bytes.toString("utf8")) as WorkFolderNode;
      if (node.v !== 1) throw new Error("Invalid working folder manifest.");
      if (node.kind === "root") await visit("manifests", node.entries, depth + 1);
      else if (node.kind === "pages") {
        for (const child of node.children) await visit("manifests", child, depth + 1);
      } else if (node.kind === "chunks") {
        for (const child of node.hashes) await visit("blobs", child, depth + 1);
      } else if (node.kind === "entries") {
        for (const e of node.entries) if (e.kind === "file") await visit("manifests", e.contents, depth + 1);
      } else throw new Error("Unsupported working folder manifest.");
    }
    await take(kind, hash, bytes);
    seen.add(key);
  }
  await visit("manifests", root, 0);
}

function writeAll(fd: number, bytes: Buffer) {
  for (let pos = 0; pos < bytes.length; ) {
    const n = writeSync(fd, bytes, pos, bytes.length - pos);
    if (!n) throw new Error("Short working folder backup write.");
    pos += n;
  }
}
function readAt(fd: number, position: number, size: number) {
  const bytes = Buffer.allocUnsafe(size);
  for (let pos = 0; pos < size; ) {
    const n = readSync(fd, bytes, pos, size - pos, position + pos);
    if (!n) throw new Error("Incomplete portable working folder backup.");
    pos += n;
  }
  return bytes;
}
function recordHeader(kind: RecordKind, hash: string, bytes: number) {
  const prefix = Buffer.alloc(prefixBytes);
  prefix[0] = codes[kind];
  prefix.writeUInt32BE(bytes, 1);
  Buffer.from(hash, "hex").copy(prefix, 5);
  randomBytes(12).copy(prefix, 37);
  return prefix;
}

export async function exportPortableFolders(
  path: string,
  layout: WorkFolderLayout,
  access: BackupFolderAccess[],
  key: Buffer,
  budget: number,
  entriesLeft: number,
) {
  const totals = emptyFolderTotals();
  const stores = access.map((a) => new BackupFolderStore(a));
  const catalog: Catalog = { layout, folders: [] };
  for (const [i, scope] of portableFolderScopes(layout).entries()) {
    if (access[i]?.id !== scope.id || access[i]?.owner !== scope.owner)
      throw new Error("Missing backup authority for working folder.");
    const head = await stores[i]!.head();
    catalog.folders.push({ ...scope, revision: head?.revision ?? null, manifest: head?.manifest ?? null });
  }
  const fd = openSync(path, "wx", 0o600);
  let size = magic.length;
  const append = (kind: RecordKind, hash: string, bytes: Buffer) => {
    const head = recordHeader(kind, hash, bytes.length);
    size += head.length + bytes.length + 16;
    if (size > budget) throw new Error("The workspace exceeds the portable backup size limit.");
    const cipher = createCipheriv("aes-256-gcm", key, head.subarray(37));
    cipher.setAAD(head);
    for (const part of [head, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]) writeAll(fd, part);
  };
  try {
    writeAll(fd, magic);
    const metadata = Buffer.from(JSON.stringify(catalog));
    if (metadata.length > metadataBytes) throw new Error("Portable working folder metadata exceeds its size limit.");
    append("catalog", folderHash(metadata), metadata);
    const seen = new Set<string>();
    for (const [i, folder] of catalog.folders.entries()) {
      const store = stores[i]!;
      if (folder.manifest) {
        await countAssignedFolder(store, folder.manifest, totals, { bytes: budget, entries: entriesLeft });
        await walkFolderObjects(folder.manifest, store.read.bind(store), async (k, h, b) => append(k, h, b), seen);
      }
    }
    for (const [i, folder] of catalog.folders.entries()) {
      if (((await stores[i]!.head())?.revision ?? null) !== folder.revision)
        throw new Error("A working folder changed during backup. Retry to export a consistent revision.");
    }
    fsyncSync(fd);
    return { size, totals };
  } finally {
    closeSync(fd);
  }
}

export class PortableFolderReader extends FolderTreeReader {
  readonly catalog: Catalog;
  private records = new Map<string, Stored>();
  private fd: number;
  private readonly key: Buffer;
  constructor(path: string, key: Buffer) {
    super();
    this.key = key;
    this.fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(this.fd);
      if (!stat.isFile() || !readAt(this.fd, 0, magic.length).equals(magic))
        throw new Error("Invalid portable working folder archive.");
      let position = magic.length;
      while (position < stat.size) {
        const raw = readAt(this.fd, position, prefixBytes);
        const kind = Object.keys(codes).find((k) => codes[k as RecordKind] === raw[0]) as RecordKind | undefined;
        const bytes = raw.readUInt32BE(1);
        if (
          !kind ||
          bytes > (kind === "catalog" ? metadataBytes : WORK_FOLDER_BLOB_BYTES) ||
          this.records.size >= maxObjects ||
          position + prefixBytes + bytes + 16 > stat.size
        )
          throw new Error("Invalid portable working folder record.");
        const k = kind === "catalog" ? kind : kind + "/" + raw.subarray(5, 37).toString("hex");
        if (this.records.has(k)) throw new Error("Duplicate working folder record.");
        this.records.set(k, { offset: position, size: bytes });
        position += prefixBytes + bytes + 16;
      }
      this.catalog = catalogSchema.parse(JSON.parse(this.decode("catalog").toString("utf8")));
      const expected = portableFolderScopes(this.catalog.layout);
      if (
        expected.length !== this.catalog.folders.length ||
        expected.some(
          (scope, i) => scope.owner !== this.catalog.folders[i]?.owner || scope.id !== this.catalog.folders[i]?.id,
        )
      )
        throw new Error("Invalid portable working folder assignments.");
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }
  private decode(name: string) {
    const r = this.records.get(name);
    if (!r) throw new Error("Missing working folder object.");
    const prefix = readAt(this.fd, r.offset, prefixBytes);
    const body = readAt(this.fd, r.offset + prefixBytes, r.size + 16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, prefix.subarray(37));
    decipher.setAAD(prefix);
    decipher.setAuthTag(body.subarray(r.size));
    const bytes = Buffer.concat([decipher.update(body.subarray(0, r.size)), decipher.final()]);
    if (folderHash(bytes) !== prefix.subarray(5, 37).toString("hex")) throw new Error("Damaged working folder object.");
    return bytes;
  }
  async read(kind: ObjectKind, hash: string) {
    return this.decode(kind + "/" + hashId.parse(hash));
  }
  close() {
    closeSync(this.fd);
  }
}
