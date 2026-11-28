import { chmod, copyFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

export const FOLDER_HELPER_ENTRY = join("laterdog", "engine-folder-cli.js");
export const PINNED_FOLDER_HELPER = "/run/laterdog-folder-helper/engine-folder-cli.js";

export async function pinFolderHelper(launcher, target = PINNED_FOLDER_HELPER) {
  const staging = `${target}.${process.pid}.next`;
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  await copyFile(join(dirname(launcher), FOLDER_HELPER_ENTRY), staging);
  await chmod(staging, 0o644);
  await rename(staging, target);
  return target;
}
