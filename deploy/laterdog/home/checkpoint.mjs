import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseManifest } from "./runtime/sync.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Checkpoint inputs must be regular files.");
}

async function fileDigest(path) {
  await regularFile(path);
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest("hex");
}

export async function verifyRetainedCheckpoint(directory) {
  await regularFile(join(directory, "maintenance.json"));
  await regularFile(join(directory, "manifest.json"));
  const maintenanceBytes = await readFile(join(directory, "maintenance.json"));
  const maintenance = JSON.parse(maintenanceBytes);
  if (maintenance?.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(maintenance.accountId ?? "") || !/^h[a-f0-9]{24}$/.test(maintenance.machineId ?? "") || !HASH.test(maintenance.stateHome ?? "") || !["standard", "large", "candidate"].includes(maintenance.targetLane) || !IMAGE.test(maintenance.sourceImageDigest ?? "") || !IMAGE.test(maintenance.targetImageDigest ?? "") || maintenance.scope !== "full-data" || maintenance.quiesced !== true || maintenance.workerReleaseProtocol !== 1 || !Array.isArray(maintenance.unsaved) || maintenance.unsaved.length || !HASH.test(maintenance.quiescenceEvidenceSha256 ?? "") || !Number.isSafeInteger(maintenance.completedAt) || maintenance.completedAt <= 0) throw new Error("Verified full-data maintenance evidence is required; workspace export or process exit does not qualify.");
  if (await fileDigest(join(directory, "quiescence-evidence.json")) !== maintenance.quiescenceEvidenceSha256) throw new Error("Quiescence evidence does not match the maintenance record.");
  const manifestBytes = await readFile(join(directory, "manifest.json"));
  const manifest = parseManifest(JSON.parse(manifestBytes));
  const hashes = new Set(manifest.entries.flatMap((entry) => entry.type === "file" ? entry.chunks : []));
  for (const hash of hashes) if (await fileDigest(join(directory, "blobs", hash)) !== hash) throw new Error("A retained checkpoint blob is corrupt.");
  const common = {
    schemaVersion: 1, accountId: maintenance.accountId, machineId: maintenance.machineId, stateHome: maintenance.stateHome,
    targetLane: maintenance.targetLane, sourceImageDigest: maintenance.sourceImageDigest, targetImageDigest: maintenance.targetImageDigest,
    manifestSha256: digest(manifestBytes), completedAt: maintenance.completedAt,
  };
  const evidence = {
    ...common, scope: "full-data", quiesced: true, workerReleaseProtocol: 1, unsaved: [], verifiedBlobs: true,
    maintenanceSha256: digest(maintenanceBytes), quiescenceEvidenceSha256: maintenance.quiescenceEvidenceSha256,
    blobCount: hashes.size, blobSetSha256: digest([...hashes].sort().join("\n")),
  };
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  const receipt = { ...common, evidenceSha256: digest(evidenceBytes), proof: "quiesced-full-data", complete: true };
  return { evidence, evidenceBytes, receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: "string" }, write: { type: "boolean", default: false } } });
  if (!values.directory) throw new Error("Pass --directory with the private full-state checkpoint directory.");
  const directory = resolve(values.directory);
  const verified = await verifyRetainedCheckpoint(directory);
  if (values.write) {
    await writeFile(join(directory, "evidence.json"), verified.evidenceBytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(directory, "receipt.json"), `${JSON.stringify(verified.receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ verified: true, blobCount: verified.evidence.blobCount, manifestSha256: verified.receipt.manifestSha256, wroteReceipts: values.write })}\n`);
}
