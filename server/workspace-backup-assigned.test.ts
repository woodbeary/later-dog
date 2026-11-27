import { afterEach, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleWorkFolder, type WorkFolderBucket } from "../deploy/laterdog/home/src/work-folder-store.ts";
import { workFolderBaseUrl, type WorkFolderGrant } from "../shared/work-folder-store.ts";
import {
  applyPendingWorkspaceRestoreAtBoot,
  commitPendingWorkspaceRestore,
  createWorkspaceBackupSnapshot,
  stageWorkspaceBackup,
  verifiedArchiveRecords,
} from "./workspace-backup.ts";
import { FolderStore } from "./laterdog/engine-folder-store.ts";
import { publishInitialWorkFolder } from "./laterdog/engine-folder-files.ts";
import {
  BackupFolderStore,
  backupFolderAccess,
  checkpointAssignedFolders,
  portableFolderScopes,
} from "./laterdog/portable-work-folders.ts";

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
      async list({ prefix, limit, cursor }) {
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix) && (!cursor || key > cursor)).sort();
        return {
          objects: keys.slice(0, limit).map((key) => ({ key })),
          truncated: keys.length > limit,
          ...(keys.length > limit ? { cursor: keys[limit - 1] } : {}),
        };
      },
      async head(key) {
        const o = objects.get(key);
        return o ? { size: o.bytes.length } : null;
      },
      async get(key) {
        const o = objects.get(key);
        return o
          ? {
              size: o.bytes.length,
              body: new Response(o.bytes as NonNullable<RequestInit["body"]>).body!,
              etag: o.etag,
            }
          : null;
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
  linkSync(join(work, "file"), join(work, "second-file"));
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
  expect(lstatSync(join(local, "second-file")).ino).toBe(lstatSync(join(local, "file")).ino);
  const tampered = await stageWorkspaceBackup(desktop, out.path, { password });
  writeFileSync(join(desktop, ".backups", tampered.id, "assigned-data", "workspaces", "dog", "file"), "altered");
  expect(() => commitPendingWorkspaceRestore(desktop, tampered.id)).toThrow(/checksum/);
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

it("keeps named shared project membership and redirects old absolute links into the archived project on a desktop", async () => {
  const { dir, source, target } = fixture();
  const data = dir("home"),
    original = dir("project"),
    desktop = dir("desktop"),
    cloud = dir("cloud");
  const project = { path: original, owner: "dog", members: ["friend"] };
  const layout = {
    dogs: ["dog"],
    tasks: {},
    projects: [project],
    loose: { owner: "dog", members: ["friend"], names: ["notes.txt"] },
    links: { "dog/dog": [original] },
  };
  const scopes = portableFolderScopes(layout),
    access = await Promise.all(scopes.map((scope) => backupFolderAccess(source, scope)));
  for (const a of access) {
    const response = await fetch(a.url + "/grant", {
      method: "POST",
      headers: { authorization: "Bearer " + a.token },
      body: JSON.stringify({ guestId: "cmp_fixture" }),
    });
    const store = new FolderStore((await response.json()) as WorkFolderGrant, () => {});
    const physical = a.id.startsWith("project-") ? original : dir("physical-" + a.id);
    if (a.id === "loose") writeFileSync(join(physical, "notes.txt"), "assigned loose file");
    if (a.id.startsWith("project-")) writeFileSync(join(physical, "notes"), "original shared notes");
    await publishInitialWorkFolder(physical, store);
    if (a.id === "dog") {
      const head = (await store.head())!,
        tree = await store.tree(head.manifest!);
      tree.entries.set("notes-link", {
        path: "notes-link",
        kind: "link",
        target: join(original, "notes"),
        scopedTarget: null,
      });
      await store.publish(tree, head.revision);
    }
  }
  const previousHome = dirname(data);
  const unchangedPrivatePath = join(previousHome, ".provider-fixture");
  writeFileSync(
    join(data, "bots.json"),
    JSON.stringify([
      {
        id: "dog",
        cwd: original,
        pinnedCwd: previousHome,
        localPath: join(previousHome, "notes.txt"),
        profileDirectory: unchangedPrivatePath,
      },
    ]),
  );
  const backup = await createWorkspaceBackupSnapshot(data, { password, folderSource: { layout, access } });
  writeFileSync(join(original, "notes"), "destination independent");
  const staged = await stageWorkspaceBackup(desktop, backup.path, { password });
  commitPendingWorkspaceRestore(desktop, staged.id);
  expect((await applyPendingWorkspaceRestoreAtBoot(desktop)).restored).toBe(true);
  expect(readFileSync(join(original, "notes"), "utf8")).toBe("destination independent");
  expect(readFileSync(join(desktop, "workspaces", "dog", "notes-link"), "utf8")).toBe("original shared notes");
  const bot = JSON.parse(readFileSync(join(desktop, "bots.json"), "utf8"))[0];
  expect(bot.cwd.startsWith(desktop + "/")).toBe(true);
  expect(readFileSync(bot.localPath, "utf8")).toBe("assigned loose file");
  expect(bot.pinnedCwd).toBe(dirname(bot.localPath));
  expect(bot.profileDirectory).toBe(unchangedPrivatePath);
  expect(readFileSync(join(bot.cwd, "notes"), "utf8")).toBe("original shared notes");
  await expect(
    stageWorkspaceBackup(cloud, backup.path, {
      password,
      folderDestination: {
        authority: target,
        layout: { ...layout, projects: [{ ...project, members: ["friend", "outsider"] }] },
      },
    }),
  ).rejects.toThrow(/assignment/);
}, 60_000);

it("honors the mount server checkpoint status and reloads through its restricted Unix socket", async () => {
  const { dir } = fixture(),
    socket = join(dir("ctl"), "checkpoint.sock"),
    seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url!);
    response.writeHead(seen.length === 1 ? 409 : 204).end();
  });
  server.listen(socket);
  await once(server, "listening");
  try {
    await expect(checkpointAssignedFolders(socket)).rejects.toMatchObject({ status: 409 });
    await checkpointAssignedFolders(socket);
    await checkpointAssignedFolders(socket, "reload");
    expect(seen).toEqual(["/v1/checkpoint", "/v1/checkpoint", "/v1/reload"]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

it("includes certified old cold-task rows only when their assigned revision still exists, without exporting their locators", async () => {
  const { dir, source } = fixture(),
    data = dir("home");
  const layout = { dogs: [], tasks: { dog: ["sealed"] }, projects: [] },
    scope = { owner: "dog", id: "task-sealed" };
  const reference = await backupFolderAccess(source, scope),
    store = new BackupFolderStore(reference);
  writeFileSync(
    join(data, "work-folders.json"),
    JSON.stringify({ "dog/sealed": { cleared: true, parts: [{ name: "private-old-locator" }] } }),
  );
  await expect(verifiedArchiveRecords(data, layout, layout, source)).rejects.toThrow(/chat files/i);
  await store.commit(null, null);
  const migratedRecords = await verifiedArchiveRecords(data, layout, layout, source);
  expect(migratedRecords).toEqual(["dog/sealed"]);
  const backup = await createWorkspaceBackupSnapshot(data, {
    password,
    folderSource: { layout, access: [reference], migratedRecords },
  });
  const target = dir("restored"),
    preview = await stageWorkspaceBackup(target, backup.path, { password });
  expect(existsSync(join(target, ".backups", preview.id, "staged", "data", "work-folders.json"))).toBe(false);
  await expect(verifiedArchiveRecords(data, { ...layout, tasks: {} }, layout, source)).rejects.toThrow(/chat files/i);
});
