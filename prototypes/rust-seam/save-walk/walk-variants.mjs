import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { Worker } from "node:worker_threads";
import { heldLock, skipped, skippedPath } from "../../../deploy/laterdog/home/runtime/sync.mjs";

function described(root, path, info) {
  return { path: relative(root, path), mode: info.mode & 0o7777, mtimeMs: Math.floor(info.mtimeMs) };
}

function walkSync(root, directory, found) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (skipped(name)) continue;
    const path = join(directory, name);
    if (skippedPath(relative(root, path))) continue;
    let info;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    const entry = described(root, path, info);
    if (info.isDirectory()) {
      if (heldLock(name, "dir")) continue;
      found.push({ ...entry, type: "dir" });
      walkSync(root, path, found);
    } else if (info.isSymbolicLink()) {
      found.push({ ...entry, type: "link", target: readlinkSync(path) });
    } else if (info.isFile()) {
      found.push({ ...entry, type: "file", size: info.size });
    }
  }
}

export function scanSync(root) {
  const found = [];
  walkSync(root, root, found);
  return found;
}

async function walkTogether(root, directory, found) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const kept = names.sort().filter((name) => !skipped(name) && !skippedPath(relative(root, join(directory, name))));
  const infos = await Promise.all(kept.map((name) => lstat(join(directory, name)).catch(() => null)));
  for (const [index, name] of kept.entries()) {
    const info = infos[index];
    if (!info) continue;
    const path = join(directory, name);
    const entry = described(root, path, info);
    if (info.isDirectory()) {
      if (heldLock(name, "dir")) continue;
      found.push({ ...entry, type: "dir" });
      await walkTogether(root, path, found);
    } else if (info.isSymbolicLink()) {
      found.push({ ...entry, type: "link", target: await readlink(path) });
    } else if (info.isFile()) {
      found.push({ ...entry, type: "file", size: info.size });
    }
  }
}

export async function scanTogether(root) {
  const found = [];
  await walkTogether(root, root, found);
  return found;
}

export function scanInWorker(root) {
  return new Promise((done, failed) => {
    const worker = new Worker(new URL("./walk-worker.mjs", import.meta.url), { workerData: { root } });
    worker.once("message", done);
    worker.once("error", failed);
  });
}
