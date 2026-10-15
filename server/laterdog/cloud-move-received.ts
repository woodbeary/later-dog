import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";

export interface ReceivedMove { environmentId: string | null; at: number }

const SOURCE = /^[\w-]{1,128}$/;
const receivedPath = (dataDir: string) => join(dataDir, ".backups", "cloud-moved.json");
const pendingPath = (dataDir: string) => join(dataDir, ".backups", "cloud-moved-pending.json");

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function parseMoveSource(value: unknown): string | null {
  return typeof value === "string" && SOURCE.test(value) ? value : null;
}

export function readReceivedMove(dataDir: string): ReceivedMove | null {
  const value = readJson(receivedPath(dataDir));
  if (!value || !Number.isSafeInteger(value.at)) return null;
  return { environmentId: parseMoveSource(value.environmentId), at: value.at as number };
}

export function noteReceivedMovePending(dataDir: string, restoreId: string, environmentId: string | null, now = Date.now()): void {
  mkdirSync(join(dataDir, ".backups"), { recursive: true, mode: 0o700 });
  writeFileAtomic(pendingPath(dataDir), JSON.stringify({ id: restoreId, environmentId, at: now }), { mode: 0o600 });
}

export function settleReceivedMove(dataDir: string, restored: { id?: string; restored?: boolean }, pendingRestore: string | null): void {
  const pending = readJson(pendingPath(dataDir));
  if (!pending || pending.id === pendingRestore) return;
  if (restored.restored && restored.id === pending.id && Number.isSafeInteger(pending.at)) {
    writeFileAtomic(receivedPath(dataDir), JSON.stringify({ environmentId: parseMoveSource(pending.environmentId), at: pending.at }), { mode: 0o600 });
  }
  rmSync(pendingPath(dataDir), { force: true });
}

export function clearReceivedMove(dataDir: string): void {
  if (existsSync(receivedPath(dataDir))) rmSync(receivedPath(dataDir), { force: true });
  rmSync(pendingPath(dataDir), { force: true });
}
