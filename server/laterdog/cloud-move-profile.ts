import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const CLOUD_MOVE_PROFILE = "cloud-move";
export type WorkspaceBackupProfile = typeof CLOUD_MOVE_PROFILE;
export const CLOUD_MOVE_LEFT_BEHIND: readonly string[] = ["task-workspaces", "native", "tool-results", "providers"];

export interface LeftOnComputer { name: string; bytes: number }

export function parseBackupProfile(value: unknown): WorkspaceBackupProfile | undefined {
  return value === CLOUD_MOVE_PROFILE ? CLOUD_MOVE_PROFILE : undefined;
}

export function leftBehindByProfile(name: string, profile?: WorkspaceBackupProfile): boolean {
  return profile === CLOUD_MOVE_PROFILE && CLOUD_MOVE_LEFT_BEHIND.includes(name);
}

function folderBytes(path: string): number {
  let bytes = 0;
  let names: string[];
  try { names = readdirSync(path); } catch { return 0; }
  for (const name of names) {
    if (name === "node_modules") continue;
    const child = join(path, name);
    try {
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) bytes += folderBytes(child);
      else if (stat.isFile()) bytes += stat.size;
    } catch {}
  }
  return bytes;
}

export function measureLeftOnComputer(dataDir: string, profile?: WorkspaceBackupProfile): LeftOnComputer[] {
  if (profile !== CLOUD_MOVE_PROFILE) return [];
  const left: LeftOnComputer[] = [];
  for (const name of CLOUD_MOVE_LEFT_BEHIND) {
    try {
      const stat = lstatSync(join(dataDir, name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) left.push({ name, bytes: folderBytes(join(dataDir, name)) });
    } catch {}
  }
  return left;
}

export function validLeftOnComputer(value: unknown): value is LeftOnComputer[] {
  return Array.isArray(value) && value.every((item) => item !== null && typeof item === "object" &&
    typeof (item as LeftOnComputer).name === "string" && CLOUD_MOVE_LEFT_BEHIND.includes((item as LeftOnComputer).name) &&
    Number.isSafeInteger((item as LeftOnComputer).bytes) && (item as LeftOnComputer).bytes >= 0);
}
