import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export const DEV_CODE_POLL_MS = 3_000;
export const DEV_CODE_LAUNCHER = "cloud-home-start.js";
const run = promisify(execFile);

export async function unpackDevCode({ hash, bytes, base, root }) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== hash) throw new Error(`the pushed server code does not match its hash (${actual.slice(0, 12)} is not ${hash.slice(0, 12)})`);
  const dir = join(root, hash.slice(0, 16));
  const launcher = join(dir, DEV_CODE_LAUNCHER);
  if (await access(launcher).then(() => true, () => false)) return launcher;
  const staging = `${dir}.unpacking`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await cp(base, staging, { recursive: true, preserveTimestamps: true });
  const archive = join(root, `${hash}.tgz`);
  await writeFile(archive, bytes);
  try {
    await run("tar", ["-xzf", archive, "-C", staging]);
  } finally {
    await rm(archive, { force: true });
  }
  await access(join(staging, DEV_CODE_LAUNCHER));
  await rm(dir, { recursive: true, force: true });
  await cp(staging, dir, { recursive: true, preserveTimestamps: true });
  await rm(staging, { recursive: true, force: true });
  return launcher;
}

export function devCodeWatcher({ store, base, root, log, onCode, intervalMs = DEV_CODE_POLL_MS, unpack = unpackDevCode }) {
  let current = null;
  let busy = false;
  let timer = null;
  const check = async () => {
    if (busy) return null;
    busy = true;
    try {
      const pointer = await store.devCode();
      if (!pointer || pointer.hash === current) return null;
      const launcher = await unpack({ hash: pointer.hash, bytes: await store.devBundle(pointer.hash), base, root });
      current = pointer.hash;
      return { launcher, hash: pointer.hash, label: pointer.label };
    } catch (error) {
      log(`pushed server code: ${error.message}`);
      return null;
    } finally {
      busy = false;
    }
  };
  return {
    first: check,
    start() {
      timer = setInterval(async () => {
        const next = await check();
        if (next) await onCode(next);
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
