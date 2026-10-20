import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RESTORE_POINTS = 3;
const BUILD_LENGTH = 12;
const UNSUPPORTED = new Set([400, 404, 405]);

function readText(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

export function appRelease(cloudRoot = "/app/cloud") {
  let version = "";
  try {
    const parsed = JSON.parse(readText(join(cloudRoot, "package.json")) || "{}");
    if (typeof parsed?.version === "string") version = parsed.version.trim();
  } catch {
    version = "";
  }
  const build = readText(join(cloudRoot, "build")).slice(0, BUILD_LENGTH);
  if (version && build) return `${version}+${build}`;
  return version || build || null;
}

export function restorePointName(manifest) {
  const createdAt = Number.isFinite(manifest?.createdAt) ? Math.max(0, Math.floor(manifest.createdAt)) : 0;
  return `${createdAt}.json`;
}

export function upgradeFrom(manifest, app) {
  return app && manifest && manifest.app !== app ? manifest : null;
}

export function storeLacksRestorePoints(error) {
  return UNSUPPORTED.has(error?.status);
}

export async function keepRestorePoint(store, manifest, { app, now = Date.now } = {}) {
  const name = restorePointName(manifest);
  await store.putRestorePoint(name, { ...manifest, keptAt: now(), ...(app ? { replacedBy: app } : {}) });
  return name;
}

export async function pruneRestorePoints(store, { limit = RESTORE_POINTS } = {}) {
  const names = await store.restorePoints();
  const stale = names.slice(0, Math.max(0, names.length - Math.max(1, limit)));
  for (const name of stale) await store.deleteRestorePoint(name);
  return stale;
}

export function upgradeKeeper(store, upgraded, { app, limit = RESTORE_POINTS, log = () => {}, now = Date.now } = {}) {
  let waiting = upgraded;
  return {
    pending() {
      return waiting ? [waiting] : [];
    },
    async keep() {
      if (!waiting) return;
      try {
        const name = await keepRestorePoint(store, waiting, { app, now });
        waiting = null;
        log(`kept restore point ${name}`);
      } catch (error) {
        if (!storeLacksRestorePoints(error)) {
          log(`could not keep the restore point yet: ${error.message}; trying again before the next save`);
          return;
        }
        waiting = null;
        log("this home's state store does not keep restore points yet");
        return;
      }
      try {
        const removed = await pruneRestorePoints(store, { limit });
        if (removed.length) log(`removed ${removed.length} older restore point(s)`);
      } catch (error) {
        log(`could not remove older restore points: ${error.message}`);
      }
    },
  };
}
