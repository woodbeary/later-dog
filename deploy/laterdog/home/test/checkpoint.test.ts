import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { verifyRetainedCheckpoint } from "../checkpoint.mjs";
import { verifyHomeCheckpoint } from "../src/checkpoint.ts";
import type { StateBucket } from "../src/state.ts";

const directories: string[] = [];
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "laterdog-checkpoint-"));
  directories.push(directory);
  await mkdir(join(directory, "blobs"));
  const blob = "fixture authentication and session state";
  const blobHash = hash(blob);
  const quiescence = JSON.stringify({ fixture: true, allWritersStopped: true });
  const maintenance = {
    schemaVersion: 1, accountId: "test-owner", machineId: `h${"1".repeat(24)}`, stateHome: "2".repeat(64), targetLane: "candidate",
    sourceImageDigest: `sha256:${"3".repeat(64)}`, targetImageDigest: `sha256:${"4".repeat(64)}`,
    scope: "full-data", quiesced: true, workerReleaseProtocol: 1, unsaved: [], quiescenceEvidenceSha256: hash(quiescence), completedAt: 1000,
  };
  const manifest = JSON.stringify({ version: 1, entries: [
    { path: ".laterdog/sessions.json", type: "file", chunks: [blobHash] },
    { path: ".laterdog/providers/account/auth.json", type: "file", chunks: [blobHash] },
  ] });
  await Promise.all([
    writeFile(join(directory, "maintenance.json"), JSON.stringify(maintenance)),
    writeFile(join(directory, "quiescence-evidence.json"), quiescence),
    writeFile(join(directory, "manifest.json"), manifest),
    writeFile(join(directory, "blobs", blobHash), blob),
  ]);
  return { directory, maintenance, manifest, blobHash };
}

it("verifies every retained blob once and gives the Worker a bounded owner/image-bound receipt", async () => {
  const f = await fixture();
  const verified = await verifyRetainedCheckpoint(f.directory);
  expect(verified.evidence).toMatchObject({ blobCount: 1, verifiedBlobs: true, scope: "full-data", unsaved: [] });
  const prefix = `checkpoints/${f.maintenance.stateHome}/checkpoint-1/`;
  const objects = new Map([
    [`${prefix}receipt.json`, JSON.stringify(verified.receipt)],
    [`${prefix}evidence.json`, verified.evidenceBytes],
    [`${prefix}manifest.json`, f.manifest],
    [`homes/${f.maintenance.stateHome}/manifest.json`, f.manifest],
  ]);
  const reads: string[] = [];
  const STATE = { get: async (key: string) => {
    reads.push(key);
    const value = objects.get(key);
    return value ? { body: new Response(value).body!, httpEtag: "fixture" } : null;
  } } as StateBucket;
  const identity = { accountId: f.maintenance.accountId, machineId: f.maintenance.machineId, host: "fixture", origin: "https://fixture" };
  const env = { STATE, CANDIDATE_HOME_CHECKPOINTS: JSON.stringify({ [identity.accountId]: "checkpoint-1" }), CANDIDATE_HOME_IMAGE_DIGEST: f.maintenance.targetImageDigest };
  await expect(verifyHomeCheckpoint(env, identity, f.maintenance.stateHome, "candidate")).resolves.toContain("checkpoint-1");
  expect(reads).toHaveLength(4);
  expect(reads.some((key) => key.includes("/blobs/"))).toBe(false);
  await expect(verifyHomeCheckpoint(env, { ...identity, accountId: "test-other" }, f.maintenance.stateHome, "candidate")).rejects.toThrow("checkpoint");
});

it.each(["missing", "corrupt"])("rejects a %s retained blob before producing a receipt", async (failure) => {
  const f = await fixture();
  if (failure === "missing") await rm(join(f.directory, "blobs", f.blobHash));
  else await writeFile(join(f.directory, "blobs", f.blobHash), "corrupt");
  await expect(verifyRetainedCheckpoint(f.directory)).rejects.toThrow();
  await expect(readFile(join(f.directory, "receipt.json"))).rejects.toThrow();
});

it.each(["workspace-export", "unsaved", "running", "old-worker", "unbound-evidence"])("rejects %s maintenance proof", async (failure) => {
  const f = await fixture();
  const maintenance: Record<string, unknown> = { ...f.maintenance };
  if (failure === "workspace-export") maintenance.scope = "workspace-export";
  if (failure === "unsaved") maintenance.unsaved = [".laterdog/providers/account/auth.json"];
  if (failure === "running") maintenance.quiesced = false;
  if (failure === "old-worker") maintenance.workerReleaseProtocol = 0;
  if (failure === "unbound-evidence") maintenance.quiescenceEvidenceSha256 = "a".repeat(64);
  await writeFile(join(f.directory, "maintenance.json"), JSON.stringify(maintenance));
  await expect(verifyRetainedCheckpoint(f.directory)).rejects.toThrow();
});
