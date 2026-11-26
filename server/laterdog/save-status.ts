import { readFileSync } from "node:fs";

export const SAVE_STATUS_PATH = "/run/laterdog-save-status.json";
export const SAVE_STATUS_FRESH_MS = 3 * 60_000;
const SAVE_STATES = new Set(["saving", "saved", "failed"]);

export interface SavedCopy {
  path: string;
  place: "memory" | "disk";
  bytes: number;
  copyMs: number;
  hashMs: number;
}

export interface SaveStatus {
  version: 1;
  state: "saving" | "saved" | "failed";
  final: boolean;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  durationMs?: number;
  copying?: string;
  heldOnDiskBytes: number;
  heldInMemoryBytes: number;
  copies: SavedCopy[];
  written?: boolean;
  uploaded?: number;
  deferred?: number;
  unsaved?: { count: number; paths: string[]; reason?: string };
  failure?: string;
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function parseSaveStatus(input: unknown): SaveStatus | null {
  if (!input || typeof input !== "object") return null;
  const status = input as Partial<SaveStatus>;
  if (status.version !== 1 || !SAVE_STATES.has(status.state as string)) return null;
  if (!count(status.startedAt) || !count(status.updatedAt) || !count(status.heldOnDiskBytes) || !count(status.heldInMemoryBytes)) return null;
  if (!Array.isArray(status.copies)) return null;
  return status as SaveStatus;
}

export function readSaveStatus(path: string = SAVE_STATUS_PATH): SaveStatus | null {
  try {
    return parseSaveStatus(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function freshSaveStatus(status: SaveStatus | null, now: number = Date.now()): status is SaveStatus {
  return status !== null && status.state !== "failed" && now - status.updatedAt <= SAVE_STATUS_FRESH_MS && status.updatedAt <= now + SAVE_STATUS_FRESH_MS;
}

export function savesForStorage(path: string = SAVE_STATUS_PATH, now: number = Date.now()): (SaveStatus & { fresh: boolean }) | null {
  const status = readSaveStatus(path);
  return status ? { ...status, fresh: freshSaveStatus(status, now) } : null;
}
