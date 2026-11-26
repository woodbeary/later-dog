import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CLOUD_MOVE_PROFILE } from "./laterdog/cloud-move-profile.ts";
import { logArchiveBridge } from "./laterdog/log-archive.ts";
import { MOVED_OUT_NOTE, WORK_FOLDER_RECORDS, WorkFolderArchive } from "./laterdog/work-folder-archive.ts";
import { createWorkspaceBackupRoutes } from "./workspace-backup-http.ts";
import { commitPendingWorkspaceRestore, createWorkspaceBackup, stageWorkspaceBackup } from "./workspace-backup.ts";

const { createArchiver, serveArchive } = await import(new URL("../deploy/laterdog/home/runtime/archive.mjs", import.meta.url).href) as {
  createArchiver(options: { root: string; store: {
    archiveIndex(): Promise<unknown>;
    putArchiveIndex(index: unknown): Promise<void>;
    hasArchived(hash: string): Promise<boolean>;
    putArchived(hash: string, bytes: Uint8Array): Promise<void>;
    getArchived(hash: string): Promise<Uint8Array>;
  } }): unknown;
  serveArchive(archiver: unknown, options: { token: string }): Promise<{ close(): Promise<void>; url: string }>;
};

const PASSWORD = "synthetic backup password";
const BOT = "11111111-2222-4333-8444-555555555555";
const THREAD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const roots: string[] = [];
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of close.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-stored-files-")));
  roots.push(dir);
  return dir;
}
async function fixture() {
  const root = directory();
  const dataDir = join(root, ".laterdog");
  const dir = join(dataDir, "task-workspaces", BOT, THREAD);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.txt"), "synthetic work must be in a complete backup\n");
  let index: unknown = null;
  const blobs = new Map<string, Uint8Array>();
  const service = await serveArchive(createArchiver({ root, store: {
    archiveIndex: async () => structuredClone(index),
    putArchiveIndex: async (next: unknown) => { index = structuredClone(next); },
    hasArchived: async (hash: string) => blobs.has(hash),
    putArchived: async (hash: string, bytes: Uint8Array) => { blobs.set(hash, new Uint8Array(bytes)); },
    getArchived: async (hash: string) => { const bytes = blobs.get(hash); if (!bytes) throw new Error("missing synthetic bytes"); return bytes; },
  } }), { token: "synthetic-workspace-archive" });
  close.push(service.close);
  const procDir = join(root, "fixture-proc");
  mkdirSync(procDir);
  const archive = new WorkFolderArchive({
    procDir, home: root, dataDir, workspacesDir: join(dataDir, "task-workspaces"), bridge: logArchiveBridge(service.url, "synthetic-workspace-archive"), chats: () => [{ dir, busy: false, closed: false, lastActiveAt: 0 }], live: () => [], limits: () => ({ idleMs: 1, byteLimit: 1024 * 1024, minFiles: 0, minBytes: 0 }), room: () => true });
  const routes = createWorkspaceBackupRoutes({ dataDir, appVersion: "1.0.0", restored: {}, authorized: () => true, status: () => ({ busy: false, pendingRestore: false }), exclusive: work => work(), readBody: async req => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString());
  } });
  const server = createServer(async (req, res) => {
    try {
      if (!await routes(req, res, new URL(req.url!, "http://localhost").pathname, { kind: "loopback", scopes: ["admin", "client"] })) { res.writeHead(404); res.end(); }
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  close.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("synthetic backup server did not listen");
  const post = (profile?: typeof CLOUD_MOVE_PROFILE) => fetch(`http://127.0.0.1:${address.port}/api/workspace-backup/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD, ...(profile ? { profile } : {}) }) });
  return { dataDir, dir, archive, post };
}

it.each([undefined, CLOUD_MOVE_PROFILE] as const)("refuses a complete backup through the real export route while chat files are stored (%s)", async profile => {
  const f = await fixture();
  expect(await f.archive.sweep()).toBeGreaterThan(0);
  expect(readdirSync(f.dir)).toEqual([MOVED_OUT_NOTE]);
  const response = await f.post(profile);
  const body = await response.json() as { id?: string; error?: string };
  if (response.status === 200) {
    const target = directory();
    const staged = await stageWorkspaceBackup(target, join(f.dataDir, ".backups", body.id!, "workspace.dogbackup"), { password: PASSWORD });
    const copied = join(target, ".backups", staged.id, "staged", "data");
    console.info(JSON.stringify({ exportStatus: response.status, originalFileOmitted: !existsSync(join(copied, "task-workspaces", BOT, THREAD, "result.txt")), storageRecordCopied: existsSync(join(copied, WORK_FOLDER_RECORDS)) }));
  }
  expect(response.status).toBe(400);
  expect(body.error).toMatch(/chat files.*storage/i);
  expect(existsSync(join(f.dataDir, ".backups")) ? readdirSync(join(f.dataDir, ".backups")) : []).toEqual([]);
  expect(f.archive.movedOut(BOT, THREAD)).not.toBeNull();
});

it("exports and stages complete work files after the stored folder comes back", async () => {
  const f = await fixture();
  await f.archive.sweep();
  expect(await f.archive.beforeTurn(BOT, THREAD)).toBe(true);
  const response = await f.post();
  const body = await response.json() as { id: string };
  expect(response.status).toBe(200);
  const target = directory();
  const staged = await stageWorkspaceBackup(target, join(f.dataDir, ".backups", body.id, "workspace.dogbackup"), { password: PASSWORD });
  expect(readFileSync(join(target, ".backups", staged.id, "staged", "data", "task-workspaces", BOT, THREAD, "result.txt"), "utf8")).toBe("synthetic work must be in a complete backup\n");
});

it.each(["{broken", "[]", "null"])("refuses an export when saved chat-file information cannot be checked (%s)", async invalid => {
  const f = await fixture();
  writeFileSync(join(f.dataDir, WORK_FOLDER_RECORDS), invalid);
  const response = await f.post();
  expect(response.status).toBe(400);
  expect((await response.json() as { error: string }).error).toMatch(/chat.file.*check/i);
});

it("refuses to commit an older backup that carries storage pointers and a note instead of the work files", async () => {
  const archived = await fixture();
  await archived.archive.sweep();
  const source = directory();
  const workPath = `task-workspaces/${BOT}/${THREAD}`;
  mkdirSync(join(source, workPath), { recursive: true });
  writeFileSync(join(source, workPath, "result.txt"), "synthetic original work\n");
  writeFileSync(join(source, WORK_FOLDER_RECORDS), "{}");
  const exported = await createWorkspaceBackup(source, { password: PASSWORD });
  const target = directory();
  writeFileSync(join(target, "keep-live.txt"), "existing destination data\n");
  const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
  const job = join(target, ".backups", staged.id);
  const data = join(job, "staged", "data");
  const manifestFile = join(job, "staged", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { entries: Array<{ path: string; type: string; mode: number; size: number; sha256?: string }>; summary: { files: number; bytes: number } };
  const original = manifest.entries.find(entry => entry.path === `${workPath}/result.txt`)!;
  manifest.summary.bytes -= original.size;
  manifest.entries = manifest.entries.filter(entry => entry !== original);
  rmSync(join(data, original.path));
  const note = Buffer.from("# These files are in storage\n");
  const path = `${workPath}/${MOVED_OUT_NOTE}`;
  writeFileSync(join(data, path), note);
  manifest.entries.push({ path, type: "file", mode: 0o600, size: note.length, sha256: createHash("sha256").update(note).digest("hex") });
  manifest.summary.bytes += note.length;
  const record = Buffer.from(JSON.stringify({ [`${BOT}/${THREAD}`]: archived.archive.movedOut(BOT, THREAD) }));
  writeFileSync(join(data, WORK_FOLDER_RECORDS), record);
  const entry = manifest.entries.find(entry => entry.path === WORK_FOLDER_RECORDS)!;
  manifest.summary.bytes += record.length - entry.size;
  entry.size = record.length;
  entry.sha256 = createHash("sha256").update(record).digest("hex");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  expect(() => commitPendingWorkspaceRestore(target, staged.id)).toThrow(/chat files.*storage/i);
  expect(existsSync(join(target, ".backups", "pending-restore.json"))).toBe(false);
  expect(readFileSync(join(target, "keep-live.txt"), "utf8")).toBe("existing destination data\n");
});
