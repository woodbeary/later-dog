import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { companionDefaults } from "./variant.ts";

export const DATA_DIR = process.env.LATERDOG_COMPANION_DIR ?? companionDefaults().dataDir;

const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(DATA_DIR, DIR_MODE);
  } catch {}
}

export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w", FILE_MODE);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
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
