import { readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getPlatformProxy } from "wrangler";

const [dir, run, guardFile, rawConcurrency = "24"] = process.argv.slice(2);
const concurrency = Number(rawConcurrency);
if (!dir || !["inspect", "check", "run"].includes(run) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 96) throw new Error("Expected directory, check|run, guard file and concurrency");
const policy = JSON.parse(await readFile(join(dir, "policy.json")));
const allowedWrites = ["blobs", "manifests", "summaries"];
let guard, guardSha, accepted;
try { accepted = JSON.parse(await readFile(join(dir, "started.json"))); } catch (error) { if (error.code !== "ENOENT") throw error; }

if (run === "run" && !policy.fixture) {
  if (!guardFile || (await stat(guardFile)).mode & 0o077) throw new Error("A private production authorization is required");
  const raw = await readFile(guardFile);
  guard = JSON.parse(raw);
  guardSha = createHash("sha256").update(raw).digest("hex");
  for (const key of ["v", "action", "account", "bucket", "stable", "sourceBucket", "sourceStable", "catalog"]) if (guard[key] !== policy[key]) throw new Error("The guarded immutable inventory differs");
  if (!(guard.expiresAt > Date.now()) && !(accepted?.guardSha === guardSha && accepted.catalog === policy.catalog && (accepted.dispatchedAt ?? accepted.at) <= guard.expiresAt)) throw new Error("Expired immutable copy authorization");
}
const pinnedVersion = JSON.parse(await readFile(join(dir, "version.json")));
const sole = deployment => {
  if (deployment.versions?.length !== 1 || deployment.versions[0].percentage !== 100 || !/^[a-f0-9-]{36}$/.test(deployment.versions[0].version_id)) throw new Error("The Courier does not have one active revision");
  return deployment.versions[0].version_id;
};
const workerVersion = sole(pinnedVersion);
const commandOptions = { timeout:30000, cwd:fileURLToPath(new URL("../../", import.meta.url)), env:{...process.env, PATH:dirname(process.execPath) + ":" + process.env.PATH} };
async function checkRevision() {
  const { stdout } = await promisify(execFile)("pnpm", ["exec", "wrangler", "deployments", "status", "--config", join(dir,"worker.json"), "--json"], commandOptions);
  if (sole(JSON.parse(stdout)) !== workerVersion) throw new Error("Live Cloudflare Worker version changed");
}
await checkRevision();
const viewed = await promisify(execFile)("pnpm", ["exec","wrangler","versions","view",workerVersion,"--config",join(dir,"worker.json"),"--json"],commandOptions);
const versionInfo = JSON.parse(viewed.stdout);
const expectedBindings = [{ bucket_name:policy.bucket, name:"DESTINATION", type:"r2_bucket" },{ bucket_name:policy.sourceBucket, name:"SOURCE", type:"r2_bucket" }];
const liveBindings = [...versionInfo.resources.bindings].sort((a,b)=>a.name.localeCompare(b.name));
if (versionInfo.id !== workerVersion || liveBindings.length !== 2 || expectedBindings.some((expected,i) => Object.entries(expected).some(([key,value])=>liveBindings[i][key] !== value))) throw new Error("Live courier R2 bindings differ");
const workerEtag = versionInfo.resources.script.etag;
if (!/^[a-f0-9]{64}$/.test(workerEtag)) throw new Error("Missing live Worker script checksum");
const proxy = await getPlatformProxy({ configPath: join(dir, "local.json"), envFiles: [], persist: false, remoteBindings: true });
const db = new DatabaseSync(join(dir, "readback.sqlite"));
try {
  const service = proxy.env.COPY, live = await service.inventory();
  for (const [key, value] of Object.entries(policy)) if (live[key] !== value) throw new Error("Remote service scope mismatch");
  const jobs = (await readFile(join(dir, "jobs.jsonl"), "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
  const { catalog, ...claims } = policy;
  const hash = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  if (live.batches !== jobs.length || hash([claims, jobs.map(j => j.id)]) !== catalog || jobs.some(j => hash([j.scope, j.objects]) !== j.id)) throw new Error("Catalog bytes differ");
  if (run === "inspect") {
    console.log(JSON.stringify({ ...policy, workerVersion, workerEtag, allowedWrites, catalogSha256: catalog, verified: true, writes: 0 }));
  } else {
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS result(catalog TEXT,action TEXT,id TEXT,n INTEGER,size INTEGER,PRIMARY KEY(catalog,action,id))");
  const done = db.prepare("SELECT 1 FROM result WHERE catalog=? AND action=? AND id=?");
  const finish = db.prepare("INSERT OR IGNORE INTO result VALUES (?,?,?,?,?)");
  if (run === "run" && !accepted) {
    if (guard && !(guard.expiresAt > Date.now())) throw new Error("Expired immutable copy authorization");
    const job = jobs[0];
    const dispatchedAt = Date.now();
    const first = await service.process("copy", job.scope, job.objects);
    if (first?.action !== "copy" || first.batch !== job.id || first.count !== job.objects.length) throw new Error("First batch acknowledgment mismatch");
    accepted = { at:Date.now(), dispatchedAt, workerVersion, workerEtag, catalog, catalogSha256:catalog, guardSha, batch:job.id, count:first.count, allowedWrites };
    await writeFile(join(dir,"started.json"),JSON.stringify(accepted),{mode:0o600,flag:"wx"});
    finish.run(catalog,"copy",job.id,first.count,first.bytes);
  }
  for (const action of run === "run" ? ["copy", "verify"] : ["verify"]) {
    await checkRevision();
    let cursor = 0, completed = 0, last = 0, failure;
    async function work() {
      while (!failure && cursor < jobs.length) {
        const job = jobs[cursor++];
        try {
          if (run === "check" || !done.get(catalog, action, job.id)) {
            let response;
            for (let tryNo = 0; ; tryNo++) {
              try { response = await service.process(action, job.scope, job.objects); break; }
              catch (error) {
                if (tryNo >= 4 || !(error instanceof Error) || /checksum|outside|unsupported|invalid|differs/i.test(error.message)) throw error;
                await new Promise(resolve => setTimeout(resolve, 250 * 2 ** tryNo));
              }
            }
            if (response.action !== action || response.batch !== job.id || response.count !== job.objects.length) throw new Error("Readback acknowledgment mismatch");
            finish.run(catalog, action, job.id, response.count, response.bytes);
          }
          completed++;
          if (Date.now() - last > 10000) { last = Date.now(); console.log(JSON.stringify({ action, completed, total: jobs.length })); }
        } catch (error) { failure = error; }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, work));
    if (failure) throw failure;
  }
  const result = db.prepare("SELECT sum(n) AS objects, sum(size) AS bytes FROM result WHERE catalog=? AND action='verify'").get(catalog);
  if (result.objects !== policy.objects) throw new Error("Incomplete readback");
  await checkRevision();
  const receipt = { at: Date.now(), ...policy, ...result, workerVersion, workerEtag, allowedWrites, catalogSha256:catalog, verified: true };
  await writeFile(join(dir, "complete.json"), JSON.stringify(receipt), { mode: 0o600 });
  console.log(JSON.stringify(receipt));
  }
} finally {
  db.close();
  await proxy.dispose();
}
