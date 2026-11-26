import { afterEach, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWorkFolder, type WorkFolderBucket } from "../deploy/laterdog/home/src/work-folder-store.ts";
import { workFolderBaseUrl, type WorkFolderGrant } from "../shared/work-folder-store.ts";
import {
  applyPendingWorkspaceRestoreAtBoot,
  commitPendingWorkspaceRestore,
  createWorkspaceBackupSnapshot,
  stageWorkspaceBackup,
} from "./workspace-backup.ts";
import { FolderStore } from "./laterdog/engine-folder-store.ts";
import { publishInitialWorkFolder } from "./laterdog/engine-folder-files.ts";
import { BackupFolderStore, backupFolderAccess } from "./laterdog/portable-work-folders.ts";

const password = "fixture-backup-key-20261126";
const items: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const item of items.splice(0)) rmSync(item, { force: true, recursive: true });
});
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "assigned-backup-")));
  items.push(directory);
  const layout = { dogs: ["dog"], tasks: {}, projects: [] };
  function account(label: string) {
    const origin = "https://" + label + ".example.test",
      bootstrap = "secret-" + label;
    const objects = new Map<string, { bytes: Buffer; etag: string }>();
    const bucket: WorkFolderBucket = {
      async head(key) {
        const o = objects.get(key);
        return o ? { size: o.bytes.length } : null;
      },
      async get(key) {
        const o = objects.get(key);
        return o ? { size: o.bytes.length, body: new Response(o.bytes as NonNullable<RequestInit["body"]>).body!, etag: o.etag } : null;
      },
      async put(key, data, opt) {
        const old = objects.get(key),
          cond = opt.onlyIf;
        if ("etagMatches" in cond ? old?.etag !== cond.etagMatches : old) return null;
        const bytes = Buffer.from(await new Response(data as NonNullable<RequestInit["body"]>).arrayBuffer());
        objects.set(key, { bytes, etag: crypto.randomUUID() });
        return {};
      },
    };
    return { origin, bootstrap, bucket };
  }
  const source = account("source"),
    target = account("destination");
  vi.stubGlobal("fetch", (url: string, options: RequestInit) => {
    const account = new URL(url).origin === source.origin ? source : target;
    return handleWorkFolder(
      new Request(url, options),
      account.bucket,
      "0".repeat(64),
      account.origin,
      account.bootstrap,
    );
  });
  function dir(name: string) {
    const path = join(directory, name);
    mkdirSync(path, { mode: 0o700, recursive: true });
    return path;
  }
  return { dir, source, target, layout };
}
it("exports independently readable cloud bytes and restores them on a desktop and another mounted home", async () => {
  const { dir, source, target, layout } = fixture(),
    data = dir("home"),
    work = dir("guest"),
    desktop = dir("desktop"),
    cloud = dir("cloud");
  const scope = { owner: "dog", id: "dog" },
    access = await backupFolderAccess(source, scope),
    base = workFolderBaseUrl(source.origin, scope.owner, scope.id);
  const res = await fetch(base + "/grant", {
    method: "POST",
    headers: { authorization: "Bearer " + access.token },
    body: JSON.stringify({ guestId: "cmp_fixture" }),
  });
  const grant = (await res.json()) as WorkFolderGrant;
  const store = new FolderStore(grant, () => {});
  const marker = "durable work payload / " + crypto.randomUUID();
  writeFileSync(join(work, "file"), marker, { mode: 0o700 });
  symlinkSync("file", join(work, "alias"));
  await publishInitialWorkFolder(work, store);
  symlinkSync("/deliberately-unavailable", join(data, "workspaces"));
  const out = await createWorkspaceBackupSnapshot(data, { password, folderSource: { layout, access: [access] } });
  expect(readFileSync(out.path).includes(Buffer.from(marker))).toBe(false);
  const staged = await stageWorkspaceBackup(desktop, out.path, { password });
  commitPendingWorkspaceRestore(desktop, staged.id);
  expect((await applyPendingWorkspaceRestoreAtBoot(desktop)).restored).toBe(true);
  const local = join(desktop, "workspaces", "dog");
  expect(readFileSync(join(local, "alias"), "utf8")).toBe(marker);
  expect(lstatSync(join(local, "alias")).isSymbolicLink()).toBe(true);
  expect(lstatSync(join(local, "file")).mode & 0o777).toBe(0o700);
  const dest = { layout, authority: target },
    to = await stageWorkspaceBackup(cloud, out.path, { password, folderDestination: dest });
  const remote = new BackupFolderStore(await backupFolderAccess(target, scope));
  expect(await remote.head()).toBeNull();
  expect(existsSync(join(cloud, ".backups", to.id, "staged", "data", "workspaces"))).toBe(false);
  expect(existsSync(join(cloud, ".backups", to.id, "archive.tar"))).toBe(false);
  commitPendingWorkspaceRestore(cloud, to.id);
  expect((await applyPendingWorkspaceRestoreAtBoot(cloud, dest)).restored).toBe(true);
  expect((await remote.head())?.manifest).toBe((await store.head())?.manifest);
}, 60_000);
it("streams older portable files directly into destination storage and refuses changes after preview", async () => {
  const { dir, target, layout } = fixture(),
    data = dir("local"),
    cloud = dir("cloud");
  const scoped = join(data, "workspaces", "dog");
  mkdirSync(scoped, { recursive: true });
  const marker = "legacy-plaintext-" + crypto.randomUUID();
  writeFileSync(join(scoped, "a.txt"), marker);
  const out = await createWorkspaceBackupSnapshot(data, { password }),
    dest = { layout, authority: target };
  const staged = await stageWorkspaceBackup(cloud, out.path, { password, folderDestination: dest });
  const remote = new BackupFolderStore(await backupFolderAccess(target, { owner: "dog", id: "dog" }));
  expect(await remote.head()).toBeNull();
  expect(existsSync(join(cloud, ".backups", staged.id, "staged", "data", "workspaces"))).toBe(false);
  await remote.commit(null, null);
  commitPendingWorkspaceRestore(cloud, staged.id);
  expect(await applyPendingWorkspaceRestoreAtBoot(cloud, dest)).toMatchObject({ restored: false, rolledBack: true });
  expect((await remote.head())?.manifest).toBeNull();
  const retry = await stageWorkspaceBackup(cloud, out.path, { password, folderDestination: dest });
  commitPendingWorkspaceRestore(cloud, retry.id);
  expect((await applyPendingWorkspaceRestoreAtBoot(cloud, dest)).restored).toBe(true);
  const entry = (await remote.tree((await remote.head())!.manifest!)).entries.get("a.txt");
  if (entry?.kind !== "file") throw Error("Missing file");
  const chunks: Buffer[] = [];
  for await (const hash of remote.leaves(entry.contents, "chunks"))
    chunks.push(await remote.read("blobs", String(hash)));
  expect(Buffer.concat(chunks).toString()).toBe(marker);
}, 60_000);
