import { chmod, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { basename } from "node:path";
import { workFolderAuthority, workFolderBaseUrl, type WorkFolderHead } from "../../shared/work-folder-store.ts";
import { mountedWorkFolders, folderGrant, linkedProjects, projectLink, visibleAliases, visibleWorkspace, type FolderScope } from "./work-folder-locations.ts";
import { WorkFolderNamespace, folderError } from "./work-folder-namespace.ts";
import { openGuestFolder, type FsRequest } from "./work-folder-guest-fs.ts";
import { WorkFolderMountRouter } from "./work-folder-mount-router.ts";
import { jobComputer } from "../computers.ts";
import { DurableFolderRead } from "./work-folder-durable-read.ts";
import { syncComputerWorkFolder } from "./engine-opener.ts";

async function main() {
  const env = process.env;
  const socket = env.LATERDOG_WORK_FOLDER_SOCKET;
  const layout = mountedWorkFolders();
  const dataDir = env.LATERDOG_HOME;
  const origin = env.LATERDOG_PUBLIC_URL;
  const secret = env.LATERDOG_CLOUD_BOOTSTRAP_SECRET;
  const uid = Number(env.LATERDOG_WORK_FOLDER_UID), gid = Number(env.LATERDOG_WORK_FOLDER_GID);
  if (!layout || !dataDir || !origin || !secret || !socket || basename(socket) !== "mount.sock" || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw new Error("Incomplete work folder mount environment");
  delete env.LATERDOG_CLOUD_BOOTSTRAP_SECRET;
  const names = new WorkFolderNamespace(layout, dataDir, visibleWorkspace(dataDir));
  const open = (scope: FolderScope) => openGuestFolder(scope, async id => {
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
  const remove = async (scope: FolderScope) => {
    const base = workFolderBaseUrl(origin, scope.owner, scope.id);
    const headers = { authorization: "Bearer " + await workFolderAuthority(secret, scope.owner, scope.id), "content-type": "application/json" };
    const call = (path: string, options: RequestInit = {}) => fetch(base + path, { ...options, headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    const reply = await call("/head");
    if (reply.status === 404) return;
    if (!reply.ok) throw folderError("EIO");
    const head = await reply.json() as WorkFolderHead;
    if (head.state === "tombstone") return;
    const range = await call("/ranges/" + head.manifest);
    if (!range.ok) throw folderError("EIO");
    const summary = await range.json() as {self:{count:number;of:string}};
    if (summary.self.of !== "root" || summary.self.count !== 0) throw folderError("ENOTEMPTY");
    const committed = await call("/commit", { method: "POST", body: JSON.stringify({ parent: head.revision, manifest: null }) });
    if (!committed.ok) throw folderError(committed.status === 409 ? "EBUSY" : "EIO");
  };
  const router = new WorkFolderMountRouter(names, open, remove, uid, gid, message => console.error(message), async scope => {
    const guest = await jobComputer(scope.owner);
    if (guest.state !== "asleep" && guest.state !== "gone") return null;
    return new DurableFolderRead(workFolderBaseUrl(origin, scope.owner, scope.id), await workFolderAuthority(secret, scope.owner, scope.id), uid, gid);
  }, (scope, inside, target) => projectLink(layout, dataDir, scope, inside, target));
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
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(await router.dispatch(operation)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      response.end(JSON.stringify({ ok: false, errno: code && /^E[A-Z0-9]+$/.test(code) ? code : "EIO" }));
    }
  });
  await rm(socket, { force: true });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(socket, resolve); });
  await chmod(socket, 0o600);
  process.stdout.write(JSON.stringify({ ready: true, version: 1 }) + "\n");
  const stop = async () => {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await router.close();
    await rm(socket, { force: true });
  };
  process.once("SIGTERM", () => { void stop().catch(error => { console.error("Work folder shutdown failed", error.message); process.exitCode = 1; }); });
}

void main().catch(error => { console.error("Work folder mount service failed", error.message); process.exitCode = 1; });
