import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export const DEV_CODE_POLL_MS = 3_000;
export const DEV_CODE_MAX_WAIT_MS = 6 * 60 * 60_000;
export const DEV_CODE_LAUNCHER = "cloud-home-start.js";
export const HOME_ACTIVITY_PATH = "/api/cloud/activity";
const HOME_ACTIVITY_TIMEOUT_MS = 5_000;
const run = promisify(execFile);

export async function unpackDevCode({ hash, bytes, base, root }) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== hash) throw new Error(`the pushed server code does not match its hash (${actual.slice(0, 12)} is not ${hash.slice(0, 12)})`);
  const dir = join(root, hash.slice(0, 16));
  const launcher = join(dir, DEV_CODE_LAUNCHER);
  if (await access(launcher).then(() => true, () => false)) return launcher;
  const staging = `${dir}.unpacking`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o755 });
  await cp(base, staging, { recursive: true, preserveTimestamps: true });
  const archive = join(root, `${hash}.tgz`);
  await writeFile(archive, bytes);
  try {
    await run("tar", ["--no-same-owner", "--no-same-permissions", "-xzf", archive, "-C", staging]);
    await run("chmod", ["-R", "go-w", staging]);
  } finally {
    await rm(archive, { force: true });
  }
  await access(join(staging, DEV_CODE_LAUNCHER));
  await rm(dir, { recursive: true, force: true });
  await cp(staging, dir, { recursive: true, preserveTimestamps: true });
  await rm(staging, { recursive: true, force: true });
  return launcher;
}

export async function homeIdle({ secret, port, timeoutMs = HOME_ACTIVITY_TIMEOUT_MS }) {
  if (!secret) return true;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(24).toString("base64url");
  const signature = createHmac("sha256", secret).update(`v1\n${timestamp}\n${nonce}\nGET\n${HOME_ACTIVITY_PATH}`).digest("base64url");
  const response = await fetch(`http://127.0.0.1:${port}${HOME_ACTIVITY_PATH}`, {
    headers: { "x-laterdog-cloud-timestamp": timestamp, "x-laterdog-cloud-nonce": nonce, "x-laterdog-cloud-signature": `v1=${signature}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) return true;
  if (!response.ok) return false;
  const activity = await response.json().catch(() => null);
  return activity?.busy === false;
}

export function devCodeWatcher({ store, base, root, log, onCode, idle = async () => true, now = Date.now, intervalMs = DEV_CODE_POLL_MS, maxWaitMs = DEV_CODE_MAX_WAIT_MS, unpack = unpackDevCode }) {
  let current = null;
  let busy = false;
  let ticking = false;
  let waiting = null;
  let timer = null;
  const check = async () => {
    if (busy) return null;
    busy = true;
    try {
      const pointer = await store.devCode();
      if (!pointer) waiting = null;
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
  const tick = async () => {
    if (ticking) return false;
    ticking = true;
    try {
      const next = await check();
      if (next) waiting = { code: next, since: waiting?.since ?? now() };
      if (!waiting) return false;
      const overdue = now() - waiting.since >= maxWaitMs;
      if (!overdue && !(await idle().catch(() => false))) {
        if (next) log(`pushed server code ${next.hash.slice(0, 12)} waits until no dog is working`);
        return false;
      }
      if (overdue) log("pushed server code waited too long for the dogs to stop; switching now");
      const ready = waiting.code;
      waiting = null;
      await onCode(ready);
      return true;
    } finally {
      ticking = false;
    }
  };
  return {
    first: check,
    tick,
    start() {
      timer = setInterval(() => {
        tick().catch((error) => log(`pushed server code: ${error.message}`));
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
