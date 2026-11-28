import { readFileSync, statSync } from "node:fs";

export const PINNED_FOLDER_HELPER_ENV = "LATERDOG_FOLDER_HELPER";

let pinned: { path: string; version: string; bytes: Buffer } | undefined;

export function pinnedFolderHelper(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const path = env[PINNED_FOLDER_HELPER_ENV];
  if (!path) return undefined;
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info?.isFile()) return undefined;
  const version = `${info.mtimeMs}:${info.size}:${info.ino}`;
  if (pinned?.path !== path || pinned.version !== version) pinned = { path, version, bytes: readFileSync(path) };
  return pinned.bytes;
}
