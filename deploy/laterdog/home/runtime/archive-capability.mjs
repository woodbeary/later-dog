import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function archiveCompatible(launcher) {
  try {
    const directory = dirname(launcher);
    const manifest = JSON.parse(await readFile(join(directory, "cloud-home-capabilities.json"), "utf8"));
    const hash = createHash("sha256").update(await readFile(join(directory, "index.js"))).digest("hex");
    return manifest.logArchive === 1 && manifest.indexSha256 === hash;
  } catch { return false; }
}
