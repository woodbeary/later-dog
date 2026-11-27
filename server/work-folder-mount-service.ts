import { ProjectAccessController } from "./laterdog/project-access.ts";
import { chmod, chown, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { basename } from "node:path";
import { workFolderAuthority, workFolderBaseUrl, type WorkFolderHead } from "../shared/work-folder-store.ts";
import { rememberProjectAccess, mountedWorkFolders, folderGrant, linkedProjects, projectLink, visibleAliases, visibleWorkspace, type FolderScope } from "./laterdog/work-folder-locations.ts";
import { WorkFolderNamespace, folderError } from "./laterdog/work-folder-namespace.ts";
import { openGuestFolder, type FsRequest } from "./laterdog/work-folder-guest-fs.ts";
import { WorkFolderMountRouter } from "./laterdog/work-folder-mount-router.ts";
import { GUEST_FOLDER_HELPER } from "./laterdog/engine-folder-process.ts";
import { guestFolderDir } from "./laterdog/engine-folder-sync.ts";
import { jobComputer } from "./computers.ts";
import { coldViews } from "./laterdog/cold-views.ts";
import { DurableFolderRead } from "./laterdog/work-folder-durable-read.ts";
import { syncComputerWorkFolder } from "./laterdog/engine-opener.ts";
import { withOperationDeadline } from "./laterdog/work-folder-op-deadline.ts";

async function main() {
  process.umask(0o077);
  const env = process.env;
  const socket = env.LATERDOG_WORK_FOLDER_SOCKET;
  const checkpoint = env.LATERDOG_WORK_FOLDER_CHECKPOINT_SOCKET;
  const layout = mountedWorkFolders();
  const dataDir = env.LATERDOG_HOME;
  const origin = env.LATERDOG_PUBLIC_URL;
  const secret = env.LATERDOG_CLOUD_BOOTSTRAP_SECRET;
  const uid = Number(env.LATERDOG_WORK_FOLDER_UID), gid = Number(env.LATERDOG_WORK_FOLDER_GID);
  if (!layout || !dataDir || !origin || !secret || !checkpoint || basename(checkpoint) !== "checkpoint.sock" || !socket || basename(socket) !== "mount.sock" || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw new Error("Incomplete work folder mount environment");
  const permissions = layout.projects.length ? new ProjectAccessController(layout, dataDir, origin, secret, rememberProjectAccess) : null;
  await permissions?.refresh();
  delete env.LATERDOG_CLOUD_BOOTSTRAP_SECRET;
  const names = new WorkFolderNamespace(layout, dataDir, visibleWorkspace(dataDir));
  const open = (scope: FolderScope) => openGuestFolder(scope, async id => {
    await permissions?.refresh();
    const projects = linkedProjects(layout, dataDir, scope, scope.owner);
    const grantFor = (s: FolderScope) => folderGrant(origin, secret, s, scope.owner, id);
    return {
      projects: await Promise.all(projects.map(async project => ({ path: project.path, grant: await grantFor(project) }))),
      folder: {
        path: scope.path, grant: await grantFor(scope), linkProjects: projects.map(project => project.path),
        ...(scope.id === "loose" ? { aliases: visibleAliases(layout, scope.owner) } : {}),
      },
    };
  }, syncComputerWorkFolder);
  const storage = async (scope: FolderScope) => {
    const base = workFolderBaseUrl(origin, scope.owner, scope.id);
    const headers = { authorization: "Bearer " + await workFolderAuthority(secret, scope.owner, scope.id), "content-type": "application/json" };
    return (path: string, options: RequestInit = {}) => fetch(base + path, { ...options, headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  };
  const makeRoot = async (scope: FolderScope, mode: number) => {
    const call = await storage(scope);
    const response = await call("/mkdir", { method: "POST", body: JSON.stringify({ mode }) });
    if (!response.ok) throw folderError(response.status === 409 || response.status === 423 ? "EBUSY" : "EIO");
  };
  const remove = async (scope: FolderScope) => {
    const call = await storage(scope);
    const reply = await call("/head");
    if (reply.status === 404) return;
    if (!reply.ok) throw folderError("EIO");
    const head = await reply.json() as WorkFolderHead;
    if (head.state === "tombstone") return;
    const guest = await jobComputer(scope.owner);
    if (guest.state === "unsure") throw folderError("EBUSY");
    if (guest.state === "running") {
      const session = await open(scope);
      session.channel.close();
      const owned = await jobComputer(scope.owner);
      if (owned.state !== "running" || owned.box.computerId !== guest.box.computerId) throw folderError("EBUSY");
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const lock = guestFolderDir(scope.path) + "/checkout.lock";
      const result = await owned.box.exec("flock -w 125 " + quote(lock) + " node " + quote(GUEST_FOLDER_HELPER) + " retire-empty " + quote(scope.path), 150_000);
      const row = result.stdout.trim().split("\n").at(-1);
      if (result.exitCode !== 0 || !row) throw folderError("EIO");
      const receipt = JSON.parse(row);
      if (receipt.ok !== true) throw folderError(["EBUSY", "ENOTEMPTY"].includes(receipt.errno) ? receipt.errno : "EIO");
      return;
    }
    const range = await call("/ranges/" + head.manifest);
    if (!range.ok) throw folderError("EIO");
    const summary = await range.json() as {self:{count:number;of:string}};
    if (summary.self.of !== "root" || summary.self.count !== 0) throw folderError("ENOTEMPTY");
    const committed = await call("/commit", { method: "POST", body: JSON.stringify({ parent: head.revision, manifest: null }) });
    if (!committed.ok) throw folderError(committed.status === 409 ? "EBUSY" : "EIO");
  };
  const coldView = coldViews(
    async (scope: FolderScope) => { const guest = await jobComputer(scope.owner); return guest.state === "asleep" || guest.state === "gone"; },
    async (scope: FolderScope) => new DurableFolderRead(workFolderBaseUrl(origin, scope.owner, scope.id), await workFolderAuthority(secret, scope.owner, scope.id), uid, gid),
  );
  const router = new WorkFolderMountRouter(names, open, remove, uid, gid, message => console.error(message), coldView, (scope, inside, target) => projectLink(layout, dataDir, scope, inside, target), makeRoot);
  const http = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/fs") { response.writeHead(404).end(); return; }
    try {
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const part of request) {
        bytes += part.length;
        if (bytes > 256 * 1024) { response.writeHead(413).end(); return; }
        parts.push(part);
      }
      const operation = JSON.parse(Buffer.concat(parts).toString("utf8")) as FsRequest;
      if (operation.op === "readlink") await permissions?.refresh();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(await withOperationDeadline(operation.op, router.dispatch(operation))));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || code === "EIO" || code === "ETIMEDOUT" || code === "MODULE_NOT_FOUND") {
        const detail = error instanceof Error ? error.message : "unknown";
        console.error("Working folder I/O failed", String(code ?? "unknown"), detail.replace(/Bearer [^ ]+|https?:\/\/[^ ]+/gi, "[remote]").slice(0, 240));
      }
      response.end(JSON.stringify({ ok: false, errno: code && /^E[A-Z0-9]+$/.test(code) ? code : "EIO" }));
    }
  });
  const checkpoints = createServer(async (request, response) => {
    if (request.method !== "POST" || (request.url !== "/v1/checkpoint" && request.url !== "/v1/reload")) { response.writeHead(404).end(); return; }
    try {
      if (request.url === "/v1/reload") { await router.reload(); await permissions?.refresh(); }
      else await router.checkpoint();
      response.writeHead(204).end();
    } catch (error) {
      response.writeHead((error as NodeJS.ErrnoException).code === "EBUSY" ? 409 : 503).end();
    }
  });
  await rm(checkpoint, { force: true });
  await new Promise<void>((resolve, reject) => { checkpoints.once("error", reject); checkpoints.listen(checkpoint, resolve); });
  await chown(checkpoint, 0, gid);
  await chmod(checkpoint, 0o660);
  await rm(socket, { force: true });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(socket, resolve); });
  await chmod(socket, 0o600);
  process.stdout.write(JSON.stringify({ ready: true, version: 1 }) + "\n");
  const stop = async () => {
    await Promise.all([http, checkpoints].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await router.close();
    await Promise.all([socket, checkpoint].map(path => rm(path, { force: true })));
  };
  process.once("SIGTERM", () => { void stop().catch(error => { console.error("Work folder shutdown failed", error.message); process.exitCode = 1; }); });
}

void main().catch(error => { console.error("Work folder mount service failed", error.message); process.exit(1); });
