import { randomBytes } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";

export const SAVE_STATUS_PATH = "/run/laterdog-save-status.json";
export const SAVE_STATUS_VERSION = 1;
export const SLOW_COPY_MS = 5_000;
export const LISTED_UNSAVED = 20;

export async function writeSaveStatus(path, status) {
  const staging = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    const handle = await open(staging, "wx", 0o644);
    try {
      await handle.writeFile(`${JSON.stringify(status)}\n`);
    } finally {
      await handle.close();
    }
    await chmod(staging, 0o644);
    await rename(staging, path);
    return true;
  } catch {
    await rm(staging, { force: true }).catch(() => {});
    return false;
  }
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function slowCopies(copies, thresholdMs = SLOW_COPY_MS) {
  return (copies ?? [])
    .filter((copy) => copy.copyMs + copy.hashMs >= thresholdMs)
    .map((copy) => `saving ${copy.path} (${Math.round(copy.bytes / 1024 / 1024)} MB) took ${seconds(copy.copyMs)} to copy to ${copy.place} and ${seconds(copy.hashMs)} to hash and upload`);
}

export function saveRecorder({ write, now = Date.now }) {
  let current = null;
  let writing = Promise.resolve();
  const saving = () => current?.state === "saving";
  const record = (fields) => {
    const status = { ...current, ...fields, updatedAt: now() };
    current = status;
    writing = writing.then(() => write(status)).catch(() => false);
    return writing;
  };
  return {
    started({ final = false } = {}) {
      current = null;
      return record({ version: SAVE_STATUS_VERSION, state: "saving", final, startedAt: now(), heldOnDiskBytes: 0, heldInMemoryBytes: 0, copies: [] });
    },
    copying({ path, place, bytes }) {
      if (!saving()) return writing;
      const held = place === "disk" ? { heldOnDiskBytes: Math.max(current.heldOnDiskBytes, bytes) } : { heldInMemoryBytes: Math.max(current.heldInMemoryBytes, bytes) };
      return record({ ...held, copying: path });
    },
    finished(result) {
      if (!saving()) return writing;
      const endedAt = now();
      return record({
        state: "saved",
        copying: undefined,
        endedAt,
        durationMs: endedAt - current.startedAt,
        heldOnDiskBytes: result.heldOnDiskBytes ?? 0,
        heldInMemoryBytes: result.heldInMemoryBytes ?? 0,
        copies: result.copies ?? [],
        written: Boolean(result.written),
        uploaded: result.uploaded ?? 0,
        deferred: result.deferred ?? 0,
        unsaved: { count: result.unsaved?.length ?? 0, paths: (result.unsaved ?? []).slice(0, LISTED_UNSAVED), ...(result.unsavedReason ? { reason: result.unsavedReason } : {}) },
      });
    },
    failed(error) {
      if (!saving()) return writing;
      const endedAt = now();
      return record({ state: "failed", copying: undefined, endedAt, durationMs: endedAt - current.startedAt, failure: String(error?.message ?? error).slice(0, 200) });
    },
  };
}
