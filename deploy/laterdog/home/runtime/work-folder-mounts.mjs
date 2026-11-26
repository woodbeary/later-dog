import { execFile, spawn } from "node:child_process";
import { mkdir, open, lstat, readdir, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const exec = promisify(execFile);
const runtime = "/run/laterdog-work-folders";
const tree = join(runtime, "tree");
const socket = join(runtime, "mount.sock");
const checkpoint = join(runtime, "checkpoint.sock");
const binary = "/app/cloud/bin/laterdog-work-folder-mount";

export function folderMounts(home, placement) {
  if (placement == null || placement.mode === "legacy" && placement.v === 1) return [];
  if (placement.v !== 1 || placement.mode !== "folders" || !Array.isArray(placement.layout?.projects) ||
      !Array.isArray(placement.layout.dogs) || !placement.layout.tasks ||
      ![placement.baselineManifest, placement.verification].every(hash => /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("Invalid durable work folder cutover");
  }
  const mounts = [
    { source: "dogs", path: ".laterdog/workspaces", directory: true },
    { source: "tasks", path: ".laterdog/task-workspaces", directory: true },
  ];
  for (const project of placement.layout.projects) {
    const name = relative(home, project.path);
    if (dirname(project.path) !== home || !name || name.startsWith(".") || name.includes(sep) || resolve(home, name) !== project.path) throw new Error("Invalid project mount");
    mounts.push({ source: "project-" + createHash("sha256").update(project.path).digest("hex"), path: name, directory: true });
  }
  if (placement.layout.loose) mounts.push({ source: "loose", path: ".laterdog-owned-work/visible", directory: true });
  for (const name of placement.layout.loose?.names ?? []) {
    if (!name || name.includes(sep) || name.startsWith(".") || name.includes("\0")) throw new Error("Invalid loose file mount");
    mounts.push({ source: "loose/" + name, path: name, directory: false });
  }
  if (new Set(mounts.map(mount => mount.path)).size !== mounts.length) throw new Error("Overlapping work folder mounts");
  return mounts;
}

export function legacyWorkFolderScope(home, placement) {
  if (!placement || placement.mode !== "legacy") return undefined;
  const mounts = folderMounts(home, { ...placement, mode: "folders" });
  const visible = new Map(mounts.filter(mount => !mount.path.startsWith(".")).map(mount => [mount.path, mount.directory ? mount.source : "loose"]));
  return path => {
    const [top, kind, dog, thread] = path.split("/");
    if (top === ".laterdog") {
      if (kind === "workspaces" && dog) return top + "/" + kind + "/" + dog;
      if (kind === "task-workspaces" && dog && thread) return [top, kind, dog, thread].join("/");
      return null;
    }
    return visible.get(top) ?? null;
  };
}

export function folderExclusions(mounts) {
  const excluded = new Set(mounts.map(mount => mount.path));
  return path => {
    if (excluded.has(path)) return true;
    const levels = path.split("/");
    return excluded.has(levels[0]) || levels.length > 1 && excluded.has(levels[0] + "/" + levels[1]);
  };
}

function ready(program, args, options) {
  const child = spawn(program, args, { ...options, stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", fail);
      child.off("exit", exited);
      lines.close();
    };
    const fail = error => {
      cleanup();
      child.kill();
      reject(error);
    };
    const exited = (code, signal) => fail(new Error("Working folder mount exited " + (code ?? signal)));
    const timeout = setTimeout(() => fail(new Error("Working folder mount timed out")), 90_000);
    child.once("error", fail);
    child.once("exit", exited);
    lines.once("line", line => {
      try {
        const status = JSON.parse(line);
        if (!status.ready || status.version !== 1) throw new Error("Invalid work folder readiness response");
        cleanup();
        resolve(child);
      } catch (error) { fail(error); }
    });
  });
}

export async function startWorkFolderMounts({ home, placement, mounts, owner, server, onLost }) {
  if (!mounts.length) return null;
  await mkdir(runtime, { recursive: true, mode: 0o755 });
  await mkdir(tree, { recursive: true, mode: 0o700 });
  const file = join(runtime, "placement.json");
  await writeFile(file, JSON.stringify(placement), { mode: 0o644 });
  await chmod(file, 0o644);
  const env = { ...process.env, LATERDOG_HOME: join(home, ".laterdog"), LATERDOG_WORK_FOLDER_LAYOUT: file, LATERDOG_WORK_FOLDER_SOCKET: socket, LATERDOG_WORK_FOLDER_CHECKPOINT_SOCKET: checkpoint, LATERDOG_WORK_FOLDER_UID: String(owner.uid), LATERDOG_WORK_FOLDER_GID: String(owner.gid) };
  const service = await ready(process.execPath, [join(server, "work-folder-mount-service.js")], { env });
  const children = [service];
  const mounted = [];
  let stopping = false;
  let shutdown;
  const stop = () => {
    if (shutdown) return shutdown;
    stopping = true;
    shutdown = (async () => {
      const failures = [];
      for (const path of [...mounted].reverse()) {
        await exec("umount", [path]).catch(error => failures.push(error));
      }
      if (children.length > 1) await exec("umount", [tree]).catch(error => failures.push(error));
      for (const child of [...children].reverse()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        await new Promise(resolve => {
          child.once("exit", resolve);
          child.kill("SIGTERM");
        });
        if (child.exitCode) failures.push(new Error("Work folder process stopped with exit " + child.exitCode));
      }
      if (failures.length) throw new AggregateError(failures, "Working folder shutdown was incomplete");
    })();
    return shutdown;
  };
  try {
    children.push(await ready(binary, ["--socket", socket, "--root", "work-folders", "--mount", tree, "--allow-other"], {}));
    for (const child of children) child.once("exit", () => { if (!stopping) onLost(); });
    for (const mount of mounts) {
      const path = join(home, mount.path);
      await mkdir(dirname(path), { recursive: true });
      const existing = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      if (existing && (existing.isSymbolicLink() || (mount.directory ? !existing.isDirectory() || (await readdir(path)).length : !existing.isFile() || existing.size !== 0))) {
        throw new Error("A working folder mount would hide existing contents: " + mount.path);
      }
      if (!existing) {
        if (mount.directory) await mkdir(path, { mode: 0o500 });
        else await (await open(path, "wx", 0o400)).close();
      }
      await exec("mount", ["--bind", join(tree, mount.source), path]);
      mounted.push(path);
    }
    return { file, checkpoint, stop };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
