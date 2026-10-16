import { hex, sha256 } from "./encoding.ts";
import type { HomeIdentity } from "./identity.ts";
import type { HomeLane } from "./size.ts";
import type { StateBucket } from "./state.ts";

export interface CheckpointEnv {
  STATE: StateBucket;
  CANDIDATE_HOME_CHECKPOINTS?: string;
  CANDIDATE_HOME_IMAGE_DIGEST?: string;
  HOME_IMAGE_DIGEST?: string;
  LARGE_HOME_IMAGE_DIGEST?: string;
}

const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CHECKPOINT_ID = /^[a-z0-9][a-z0-9-]{7,79}$/;
export const CHECKPOINT_REQUIRED = "This home needs a verified full-state checkpoint before changing release lanes.";

export function checkpointSelection(env: CheckpointEnv, accountId: string, lane: HomeLane): { id: string; image: string; key: string } {
  let selected: unknown;
  try {
    selected = JSON.parse(env.CANDIDATE_HOME_CHECKPOINTS ?? "{}")[accountId];
  } catch {
    throw new Error(CHECKPOINT_REQUIRED);
  }
  const image = lane === "candidate" ? env.CANDIDATE_HOME_IMAGE_DIGEST : lane === "large" ? env.LARGE_HOME_IMAGE_DIGEST : env.HOME_IMAGE_DIGEST;
  if (typeof selected !== "string" || !CHECKPOINT_ID.test(selected) || !image || !DIGEST.test(image)) throw new Error(CHECKPOINT_REQUIRED);
  return { id: selected, image, key: `${lane}:${selected}:${image}` };
}

async function bytes(bucket: StateBucket, key: string, maximum = 65_536): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) throw new Error(CHECKPOINT_REQUIRED);
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("The release checkpoint exceeds the bounded verification size.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function verifyHomeCheckpoint(env: CheckpointEnv, identity: HomeIdentity, stateHome: string, lane: HomeLane): Promise<string> {
  const selected = checkpointSelection(env, identity.accountId, lane);
  const prefix = `checkpoints/${stateHome}/${selected.id}/`;
  const receipt = JSON.parse(new TextDecoder().decode(await bytes(env.STATE, `${prefix}receipt.json`)));
  if (receipt?.schemaVersion !== 1 || receipt.accountId !== identity.accountId || receipt.machineId !== identity.machineId || receipt.stateHome !== stateHome || receipt.targetLane !== lane || receipt.targetImageDigest !== selected.image || !DIGEST.test(receipt.sourceImageDigest ?? "") || !HASH.test(receipt.manifestSha256 ?? "") || !HASH.test(receipt.evidenceSha256 ?? "") || receipt.proof !== "quiesced-full-data" || receipt.complete !== true || !Number.isSafeInteger(receipt.completedAt) || receipt.completedAt <= 0) throw new Error(CHECKPOINT_REQUIRED);
  const evidenceBytes = await bytes(env.STATE, `${prefix}evidence.json`);
  if (hex(await sha256(evidenceBytes)) !== receipt.evidenceSha256) throw new Error(CHECKPOINT_REQUIRED);
  const evidence = JSON.parse(new TextDecoder().decode(evidenceBytes));
  if (evidence?.schemaVersion !== 1 || evidence.scope !== "full-data" || evidence.quiesced !== true || evidence.verifiedBlobs !== true || evidence.workerReleaseProtocol !== 1 || !Array.isArray(evidence.unsaved) || evidence.unsaved.length !== 0 || ["accountId", "machineId", "stateHome", "sourceImageDigest", "targetImageDigest", "targetLane", "manifestSha256", "completedAt"].some((key) => evidence[key] !== receipt[key])) throw new Error(CHECKPOINT_REQUIRED);
  const [current, retained] = await Promise.all([
    bytes(env.STATE, `homes/${stateHome}/manifest.json`, 8 * 1024 * 1024),
    bytes(env.STATE, `${prefix}manifest.json`, 8 * 1024 * 1024),
  ]);
  if (hex(await sha256(current)) !== receipt.manifestSha256 || hex(await sha256(retained)) !== receipt.manifestSha256) throw new Error(CHECKPOINT_REQUIRED);
  const manifest = JSON.parse(new TextDecoder().decode(retained));
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) throw new Error(CHECKPOINT_REQUIRED);
  const hashes = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry || !["dir", "file", "link"].includes(entry.type) || typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.split("/").includes("..")) throw new Error(CHECKPOINT_REQUIRED);
    if (entry.type === "link" && typeof entry.target !== "string") throw new Error(CHECKPOINT_REQUIRED);
    if (entry.type !== "file") continue;
    if (!Array.isArray(entry.chunks) || entry.chunks.some((hash: unknown) => typeof hash !== "string" || !HASH.test(hash))) throw new Error(CHECKPOINT_REQUIRED);
    for (const hash of entry.chunks) hashes.add(hash);
  }
  if (evidence.blobCount !== hashes.size || evidence.blobSetSha256 !== hex(await sha256([...hashes].sort().join("\n")))) throw new Error(CHECKPOINT_REQUIRED);
  return selected.key;
}
