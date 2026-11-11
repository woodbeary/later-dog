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

async function walkOneAtATime(root, directory, found) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (skipped(name)) continue;
    const path = join(directory, name);
    if (skippedPath(relative(root, path))) continue;
    let info;
    try {
      info = await lstat(path);
    } catch {
      continue;
    }
    const entry = described(root, path, info);
    if (info.isDirectory()) {
      if (heldLock(name, "dir")) continue;
      found.push({ ...entry, type: "dir" });
      await walkOneAtATime(root, path, found);
    } else if (info.isSymbolicLink()) {
      found.push({ ...entry, type: "link", target: await readlink(path) });
    } else if (info.isFile()) {
      found.push({ ...entry, type: "file", size: info.size });
    }
  }
}

export async function scanOneAtATime(root) {
  const found = [];
  await walkOneAtATime(root, root, found);
  return found;
}

async function inBatches(paths, width) {
  const infos = [];
  for (let start = 0; start < paths.length; start += width) {
    infos.push(...(await Promise.all(paths.slice(start, start + width).map((path) => lstat(path).catch(() => null)))));
  }
  return infos;
}

async function walkInBatches(root, directory, found, width) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const kept = names.sort().filter((name) => !skipped(name) && !skippedPath(relative(root, join(directory, name))));
  const infos = await inBatches(kept.map((name) => join(directory, name)), width);
  for (const [index, name] of kept.entries()) {
    const info = infos[index];
    if (!info) continue;
    const path = join(directory, name);
    const entry = described(root, path, info);
    if (info.isDirectory()) {
      if (heldLock(name, "dir")) continue;
      found.push({ ...entry, type: "dir" });
      await walkInBatches(root, path, found, width);
    } else if (info.isSymbolicLink()) {
      found.push({ ...entry, type: "link", target: await readlink(path) });
    } else if (info.isFile()) {
      found.push({ ...entry, type: "file", size: info.size });
    }
  }
}

export async function scanInBatches(root, width) {
  const found = [];
  await walkInBatches(root, root, found, width);
  return found;
}

function takingTurns(width) {
  let free = width;
  let head = 0;
  const waiting = [];
  return async (work) => {
    if (free > 0) free -= 1;
    else await new Promise((go) => waiting.push(go));
    try {
      return await work();
    } finally {
      if (head < waiting.length) waiting[head++]();
      else free += 1;
    }
  };
}

async function listedAcross(root, directory, limited) {
  let names;
  try {
    names = await limited(() => readdir(directory));
  } catch {
    return [];
  }
  const kept = names.sort().filter((name) => !skipped(name) && !skippedPath(relative(root, join(directory, name))));
  return Promise.all(
    kept.map(async (name) => {
      const path = join(directory, name);
      let info;
      try {
        info = await limited(() => lstat(path));
      } catch {
        return null;
      }
      const entry = described(root, path, info);
      if (info.isDirectory()) return heldLock(name, "dir") ? null : { entry: { ...entry, type: "dir" }, inside: await listedAcross(root, path, limited) };
      if (info.isSymbolicLink()) return { entry: { ...entry, type: "link", target: await limited(() => readlink(path)) } };
      if (info.isFile()) return { entry: { ...entry, type: "file", size: info.size } };
      return null;
    }),
  );
}

function inWalkOrder(parts, found) {
  for (const part of parts) {
    if (!part) continue;
    found.push(part.entry);
    if (part.inside) inWalkOrder(part.inside, found);
  }
  return found;
}

export async function scanAcross(root, width) {
  return inWalkOrder(await listedAcross(root, root, takingTurns(width)), []);
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
