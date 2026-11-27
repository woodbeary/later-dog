import { join, resolve } from "node:path";

import { DATA_DIR } from "../config.ts";
import { createMountGuard, mountFiles } from "./mount-guard.ts";

export const WORKSPACES_DIR = join(DATA_DIR, "workspaces");
export const TASK_WORKSPACES_DIR = join(DATA_DIR, "task-workspaces");

let mountedFolders: readonly string[] = [];

export function guardMountedFolders(paths: readonly string[]): void {
  const dogRoots = new Set([WORKSPACES_DIR, TASK_WORKSPACES_DIR].map((path) => resolve(path)));
  mountedFolders = paths.map((path) => resolve(path)).filter((path) => !dogRoots.has(path));
}

export const mountGuard = createMountGuard({ roots: () => [WORKSPACES_DIR, TASK_WORKSPACES_DIR], folders: () => mountedFolders });
export const dogFiles = mountFiles(mountGuard);

export function dogFoldersMounted(): boolean {
  return process.env.LATERDOG_CLOUD_ROLE === "home" && Boolean(process.env.LATERDOG_WORK_FOLDER_LAYOUT);
}

export function onMountedFolder(path: string): boolean {
  return dogFoldersMounted() && mountGuard.folderOf(resolve(path)) !== null;
}

export async function realFolderPath(path: string): Promise<string | undefined> {
  try { return await dogFiles.realpath(path); } catch { return undefined; }
}
