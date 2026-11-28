import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ARCHIVE_CAPABILITY = 4;

export const WORK_FOLDER_PROGRAMS = ["laterdog/engine-folder-cli.js", "work-folder-mount-service.js", "laterdog/engine-relay.js"];

export async function archiveCompatible(launcher, { workFolders = false, history = false } = {}) {
  try {
    const directory = dirname(launcher);
    const manifest = JSON.parse(await readFile(join(directory, "cloud-home-capabilities.json"), "utf8"));
    const hash = createHash("sha256").update(await readFile(join(directory, "index.js"))).digest("hex");
    const launcherHash = createHash("sha256").update(await readFile(launcher)).digest("hex");
    if (history && (manifest.history !== 1 || manifest.historyTransportSha256 !== createHash("sha256").update(await readFile(join(directory, "history-transport.worker.js"))).digest("hex"))) return false;
    if (workFolders) {
      if (manifest.workFolders !== 1) return false;
      for (const name of WORK_FOLDER_PROGRAMS) {
        const actual = createHash("sha256").update(await readFile(join(directory, name))).digest("hex");
        if (manifest.workFolderHashes?.[name] !== actual) return false;
      }
    }
    return manifest.logArchive === ARCHIVE_CAPABILITY && manifest.indexSha256 === hash && manifest.launcherSha256 === launcherHash;
  } catch { return false; }
}
