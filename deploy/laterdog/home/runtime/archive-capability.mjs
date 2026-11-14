import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ARCHIVE_CAPABILITY = 3;
export const FOLDER_AWAY_CAPABILITY = 1;

export async function archiveCompatible(launcher) {
  try {
    const directory = dirname(launcher);
    const manifest = JSON.parse(await readFile(join(directory, "cloud-home-capabilities.json"), "utf8"));
    const hash = createHash("sha256").update(await readFile(join(directory, "index.js"))).digest("hex");
    const launcherHash = createHash("sha256").update(await readFile(launcher)).digest("hex");
    return manifest.logArchive === ARCHIVE_CAPABILITY && manifest.indexSha256 === hash && manifest.launcherSha256 === launcherHash;
  } catch { return false; }
}

export async function bringsFoldersBack(launcher) {
  if (!await archiveCompatible(launcher)) return false;
  try {
    const manifest = JSON.parse(await readFile(join(dirname(launcher), "cloud-home-capabilities.json"), "utf8"));
    return Number.isInteger(manifest.folderAway) && manifest.folderAway >= FOLDER_AWAY_CAPABILITY;
  } catch { return false; }
}
