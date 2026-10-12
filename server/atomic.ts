import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export type AtomicWriteOptions = {
  mode?: number;
  durable?: boolean;
};

const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameWithRetry(
  tmp: string,
  path: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw e;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

export function writeFileAtomic(path: string, data: string, options: AtomicWriteOptions = {}): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w", options.mode);
    writeFileSync(fd, data);
    if (options.durable !== false) fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameWithRetry(tmp, path);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function holdsExactly(path: string, data: string, mode: number | undefined): boolean {
  let fd: number | null = null;
  try {
    if (process.platform === "win32") {
      if (!lstatSync(path).isFile()) return false;
      fd = openSync(path, "r");
    } else {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== Buffer.byteLength(data)) return false;
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return false;
    if (mode !== undefined && process.platform !== "win32" && (stat.mode & 0o777 & ~mode) !== 0) return false;
    return readFileSync(fd).equals(Buffer.from(data));
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export function writeFileAtomicIfChanged(path: string, data: string, options: AtomicWriteOptions = {}): boolean {
  if (holdsExactly(path, data, options.mode)) return false;
  writeFileAtomic(path, data, options);
  return true;
}
