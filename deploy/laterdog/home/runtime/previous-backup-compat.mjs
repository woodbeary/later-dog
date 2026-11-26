import { createHash } from "node:crypto";

const directory = ".laterdog/.backups/cloud-previous/";
const archivePath = directory + "workspace.dogbackup";
const referencePath = directory + "backup-reference.json";

export function projectPreviousCloudBackup(manifest, placement) {
  if (placement?.mode !== "folders") return manifest;
  const archive = manifest.entries.find(entry => entry.path === archivePath && entry.type === "file");
  if (!archive) return manifest;
  const entries = manifest.entries.filter(entry => entry !== archive);
  if (entries.some(entry => entry.path === directory + "previous.json" && entry.type === "file") && !entries.some(entry => entry.path === referencePath)) {
    const bytes = Buffer.from(JSON.stringify({ v: 1, source: "baseline", baseline: placement.baselineManifest, size: archive.size }));
    const hash = createHash("sha256").update(bytes).digest("hex");
    entries.push({ path: referencePath, type: "file", mode: 0o600, mtimeMs: archive.mtimeMs, size: bytes.length, chunks: [hash] });
  }
  return { ...manifest, entries };
}
