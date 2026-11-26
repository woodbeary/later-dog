import { readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getPlatformProxy } from "wrangler";

const [dir, guardFile, profile = "queue"] = process.argv.slice(2), policy = JSON.parse(await readFile(join(dir,"policy.json")));
if (!["queue", "parallel"].includes(profile)) throw new Error("Unknown private coordinator");
const accepted = JSON.parse(await readFile(join(dir,"started.json")));
const options = {timeout:30000,cwd:fileURLToPath(new URL("../../",import.meta.url)),env:{...process.env,PATH:dirname(process.execPath)+":"+process.env.PATH}};
if (!policy.fixture) {
  const raw = await readFile(guardFile), guard=JSON.parse(raw);
  if ((await stat(guardFile)).mode & 0o077 || accepted.guardSha !== createHash("sha256").update(raw).digest("hex") || !(accepted.dispatchedAt<=guard.expiresAt) || accepted.catalog!==policy.catalog || !["v","account","action","catalog","bucket","stable","sourceBucket","sourceStable"].every(k=>guard[k]===policy[k])) throw new Error("Existing immutable job has no matching original authorization");
}

async function revision(file) {
  const r=await promisify(execFile)("pnpm",["exec","wrangler","deployments","status","--config",join(dir,file),"--json"],options);
  const versions=JSON.parse(r.stdout).versions;
  if(versions.length!==1||versions[0].percentage!==100)throw new Error("Ambiguous deployed version");
  return versions[0].version_id;
}
const queueVersion=JSON.parse(await readFile(join(dir,profile+"-version.json"))).versions[0].version_id;
async function guard() {if(await revision("worker.json")!==accepted.workerVersion||await revision(profile+"-worker.json")!==queueVersion)throw new Error("Courier or queue deployment changed")}
await guard();
const jobs=(await readFile(join(dir,"jobs.jsonl"),"utf8")).trim().split("\n").map(l=>JSON.parse(l));
const expected=new Map(jobs.map(j=>[j.id,j])), proxy=await getPlatformProxy({configPath:join(dir,profile+"-local.json"),persist:false,envFiles:[],remoteBindings:true});
const db=new DatabaseSync(join(dir,"readback.sqlite"));db.exec("PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL");
const done=db.prepare("SELECT 1 FROM result WHERE catalog=? AND action='verify' AND id=?"),finish=db.prepare("INSERT OR IGNORE INTO result VALUES(?,?,?,?,?)");
const completeIds=new Set();
const service=proxy.env.DISPATCH;
try {
 const actual=await service.inventory();
 if(actual.catalog!==policy.catalog||actual.objects!==policy.objects||actual.batches!==jobs.length)throw new Error("Queue catalog mismatch");
 async function collect() {
  let cursor=null;
  do{
   const p=await service.list(cursor||"");cursor=p.cursor;
   db.exec("BEGIN IMMEDIATE");
   try{
    for(const [id,r] of p.rows){
     if(completeIds.has(id))continue;
     const j=expected.get(id);
     if(!j||r.verified!=="true"||Number(r.count)!==j.objects.length||!Number.isSafeInteger(Number(r.bytes)))throw new Error("Unrecognized private readback receipt");
     finish.run(policy.catalog,"copy",id,j.objects.length,Number(r.copied));
     finish.run(policy.catalog,"verify",id,j.objects.length,Number(r.bytes));
     completeIds.add(id);
    }
    db.exec("COMMIT");
   }catch(error){db.exec("ROLLBACK");throw error}
  }while(cursor);
 }
 await collect();
 const missing=jobs.filter(j=>policy.fixture ? !completeIds.has(j.id) : !done.get(policy.catalog,j.id));
 for(let i=0;i<missing.length;i+=24){
  const group=missing.slice(i,i+24);
  const receipt=await service.enqueue(group.map(j=>({...j,catalog:policy.catalog})));
  if(JSON.stringify(receipt.accepted)!==JSON.stringify(group.map(j=>j.id)))throw new Error("Unexpected queue acceptance");
  if(i%480===0)console.log(JSON.stringify({submitted:i+group.length,total:missing.length}));
 }
 let last=0;
 while(true){
  await collect();
  const {count}=db.prepare("SELECT count(*) AS count FROM result WHERE catalog=? AND action='verify'").get(policy.catalog);
  if((policy.fixture ? completeIds.size : count)===jobs.length)break;
  if(Date.now()-last>15000){last=Date.now();console.log(JSON.stringify({acknowledged:count,total:jobs.length}));}
  await new Promise(resolve=>setTimeout(resolve,5000));
 }
 await guard();
 const result=db.prepare("SELECT sum(n) AS objects,sum(size) AS bytes FROM result WHERE catalog=? AND action='verify'").get(policy.catalog);
 if(result.objects!==policy.objects)throw new Error("Incomplete immutable readback");
 const receipt={at:Date.now(),...policy,...result,workerVersion:accepted.workerVersion,workerEtag:accepted.workerEtag,queueVersion,allowedWrites:["blobs","manifests","summaries"],catalogSha256:policy.catalog,verified:true};
 await writeFile(join(dir,profile+"-complete.json"),JSON.stringify(receipt),{mode:0o600});
 console.log(JSON.stringify(receipt));
}finally{db.close();await proxy.dispose()}
