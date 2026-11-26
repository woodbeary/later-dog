import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { getPlatformProxy } from "wrangler";

const [action, specFile, configFile, planFile, leaseFile] = process.argv.slice(2);
function requireState(ok, message) {
  if (!ok) throw Error(message);
}
const decode = async path => JSON.parse(await readFile(path));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
requireState(["start", "inspect", "seal"].includes(action) && specFile && configFile && planFile, "Expected start|inspect|seal, release specification, binding config and candidate plan");
const spec = await decode(specFile), cfg = await decode(configFile), plan = await decode(planFile);
requireState(/^[a-f0-9]{32}$/.test(spec.cloudflareAccount) && cfg.account_id === spec.cloudflareAccount &&
  uuid.test(spec.applicationId) && uuid.test(spec.workerVersion) && /^[a-z0-9-]+$/.test(spec.worker) && /^[a-z0-9-]+$/.test(spec.bucket) &&
  hash.test(spec.stable) && /^[a-f0-9]{40}$/.test(spec.commit) && hash.test(spec.image) && hash.test(spec.baselineManifest) &&
  plan.v === 1 && [plan.index, plan.verification, plan.placementSha256].every(v => hash.test(v)) && plan.proofSha256 === plan.verification,
  "Invalid restore specification or candidate plan");
requireState(cfg.r2_buckets?.length === 1 && cfg.r2_buckets[0].binding === "STATE" && cfg.r2_buckets[0].remote === true &&
  cfg.r2_buckets[0].bucket_name === spec.bucket && cfg.services?.some(s => s.binding === "OPS" && s.service === spec.worker && s.entrypoint === "RestoreOperator" && s.remote === true),
  "Wrong restore service or bucket");
const cloudAuth = JSON.parse((await promisify(execFile)("pnpm", ["exec", "wrangler", "auth", "token", "--json"], { timeout: 30_000 })).stdout);
const cloud = async path => {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts/" + spec.cloudflareAccount + "/" + path, {
    headers: { authorization: "Bearer " + cloudAuth.token }, signal: AbortSignal.timeout(30_000),
  });
  requireState(response.ok, "Cloudflare inventory returned " + response.status);
  const result = await response.json();
  requireState(result.success, "Cloudflare inventory unavailable");
  return result.result;
};
const applicationPath = "containers/applications/" + spec.applicationId;
const workersPath = "workers/scripts/" + spec.worker;
async function platform() {
  const [app, deployments, version] = await Promise.all([cloud(applicationPath), cloud(workersPath + "/deployments"), cloud(workersPath + "/versions/" + spec.workerVersion)]);
  const traffic = deployments.deployments[0]?.versions;
  requireState(traffic?.length === 1 && traffic[0].version_id === spec.workerVersion && traffic[0].percentage === 100, "Candidate Worker traffic changed");
  const bindings = version.resources.bindings;
  requireState(bindings.some(b => b.type === "r2_bucket" && b.name === "STATE" && b.bucket_name === spec.bucket) &&
    bindings.some(b => b.name === "TENANT" && b.text === spec.stable) && bindings.some(b => b.name === "IMAGE_HASH" && b.text === spec.image) &&
    bindings.some(b => b.name === "DISKS" && b.namespace_id === app.durable_objects.namespace_id && b.class_name === "RestoreDisk") &&
    app.name === spec.worker + "-restoredisk" && app.configuration.image.endsWith("@sha256:" + spec.image), "Live candidate configuration changed");
  return app.configuration.image;
}
const image = await platform();
const proxy = await getPlatformProxy({ configPath: resolve(configFile), envFiles: [], persist: false, remoteBindings: true });
const { STATE, OPS, SOURCE } = proxy.env;
const prefix = "homes/" + spec.stable + "/work-folders/";
async function immutable(category, value) {
  const raw = JSON.stringify(value), sha = digest(raw), key = prefix + category + "/" + sha;
  await STATE.put(key, raw, { onlyIf: { etagDoesNotMatch: "*" } });
  requireState(await (await STATE.get(key))?.text() === raw, "Candidate receipt readback differs");
  return sha;
}
try {
  const permit = { v: 1, stable: spec.stable, image: spec.image, index: plan.index, placement: plan.placementSha256, verification: plan.verification, baselineManifest: spec.baselineManifest };
  const run = digest(JSON.stringify(permit));
  if (action === "start") {
    for (const sha of [plan.index, plan.verification, plan.placementSha256]) {
      const bytes = await (await STATE.get(prefix + "cutover-plans/" + plan.verification + "/" + sha))?.arrayBuffer();
      requireState(bytes && digest(Buffer.from(bytes)) === sha, "Candidate plan has not been sealed");
    }
    await immutable("cutover-runs", permit);
    const started = await OPS.start(run);
    requireState(started.run === run && hash.test(started.id), "Unexpected candidate launch");
    console.log(JSON.stringify(started));
  } else {
    const result = await OPS.status();
    requireState(result.run === run && typeof result.candidateDisk === "string", "The physical candidate has no matching active run");
    const [disk, boot, device] = result.candidateDisk.split("/");
    requireState(hash.test(disk) && uuid.test(boot) && /^\d+$/.test(device), "Invalid physical disk identity");
    const box = await cloud(applicationPath + "/instances/" + disk);
    requireState(box.status.state === "running" && box.id === disk && box.name === spec.stable && box.application_id === spec.applicationId && box.image === image, "Physical candidate is not on the expected image");
    if (result.state === "verified") {
      for (const key of ["stable", "verification", "baselineManifest", "index", "image"]) requireState(result[key] === permit[key], "Different verified run inputs");
      for (const key of ["scopes", "files", "bytes"]) requireState(result[key] === plan[key], "Incomplete physical working folders");
      requireState(result.sourceCommit === spec.commit.slice(0, 12) && result.restored === true && result.appStarted === false && Number.isSafeInteger(result.coordinator?.files) && Number.isSafeInteger(result.coordinator.bytes), "Unexpected image build or coordinator restore");
    }
    if (action === "inspect") console.log(JSON.stringify(result));
    else {
      requireState(result.state === "verified" && leaseFile && ((await stat(leaseFile)).mode & 0o077) === 0, "Sealing requires a completed real restore and private source lease");
      const { accountId, machineId, lease, service } = await decode(leaseFile);
      requireState(accountId === spec.accountId && machineId === spec.machineId && hash.test(lease) && cfg.services.some(s => s.binding === "SOURCE" && s.service === service && s.service === spec.sourceWorker && s.entrypoint === "WorkFolderMigrationApi" && s.remote === true), "Different cutover authority");
      const held = await SOURCE.cutover(accountId, lease, { op: "status" });
      requireState(held.phase === "held" && held.disk.phase === "held" && held.expiresAt > Date.now() && held.machineId === machineId && held.stable === spec.stable && held.image === spec.image && held.baselineManifest === spec.baselineManifest &&
        held.sourceDisk.split("/")[0] !== disk && held.disk.boot !== boot, "Source freeze no longer matches the candidate");
      const restoreResult = await immutable("cutover-restore-results", result);
      const receipt = { v: 1, stable: spec.stable, machineId, lease, sourceBoot: held.disk.boot, sourceMountId: held.disk.mountId, baselineManifest: spec.baselineManifest, verification: plan.verification, image: spec.image, candidateDisk: result.candidateDisk, sourceDisk: held.sourceDisk, restored: true, appStarted: false, restoreResult };
      console.log(JSON.stringify({ candidate: await immutable("cutover-candidates", receipt), restoreResult, run, candidateDisk: result.candidateDisk }));
    }
  }
} finally {
  await proxy.dispose();
}
