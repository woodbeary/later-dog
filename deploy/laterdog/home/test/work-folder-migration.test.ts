import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { handleWorkFolder, type WorkFolderBucket } from "../src/work-folder-store.ts";
import { handleWorkFolderPlacement, workFolderControlPath } from "../src/work-folder-placement.ts";
import { authorizedState, handleState } from "../src/state.ts";

it("migrates the resident and archived working folders and restores the newest guest work to a compatible home", async () => {
  const bytes = new Map<string, { data: Buffer; etag: string; uploaded: Date }>();
  const bucket: WorkFolderBucket = {
    async get(key) {
      const value = bytes.get(key);
      return value ? { ...value, size:value.data.length, httpEtag:'"' + value.etag + '"', body:new Response(value.data).body! } : null;
    },
    async head(key) {
      const v=bytes.get(key);
      return v ? { size:v.data.length, uploaded:v.uploaded } : null;
    },
    async list({prefix}) { return {truncated:false,objects:[...bytes.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key}))}; },
    async put(key, value, options) {
      const old = bytes.get(key), condition = options.onlyIf;
      if (condition && ("etagMatches" in condition ? old?.etag !== condition.etagMatches : old)) return null;
      const data = Buffer.from(await new Response(value as BodyInit).arrayBuffer());
      if (options.sha256 && createHash("sha256").update(data).digest("hex")!==options.sha256) throw new Error("Incorrect R2 checksum");
      const etag = createHash("md5").update(data).digest("hex");
      bytes.set(key,{data,etag,uploaded:new Date()}); return {etag};
    },
  };
  const dir=await mkdtemp(join(tmpdir(),"laterdog-folder-migration-")), stable="e".repeat(64);
  let origin="";
  const server=createServer(async (req,res)=>{
    try {
      const payload = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
      const request = new Request(origin+req.url,{method:req.method,headers:req.headers as Record<string,string>,body:payload as BodyInit,duplex:"half"} as RequestInit);
      const path=new URL(request.url).pathname;
      const response=path.startsWith("/api/work-folders/v1/") ? await handleWorkFolder(request,bucket,stable,origin,"migration-fixture")
        : !await authorizedState(request,"control-fixture") ? new Response(null,{status:401})
        : workFolderControlPath(path) ? await handleWorkFolderPlacement(request,bucket,stable,"migration-fixture")
        : await handleState(request,bucket as Parameters<typeof handleState>[1],stable);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) { res.writeHead(500).end(String(err)); }
  });
  try {
    await new Promise<void>((resolve,reject)=>server.once("error",reject).listen(0,"127.0.0.1",resolve));
    const address=server.address(); if (!address || typeof address==="string") throw new Error("Missing fixture port");
    origin="http://127.0.0.1:"+address.port;
    const migration=new URL("../migration/",import.meta.url);
    const result=await promisify(execFile)("python3",["-c","import json,pathlib,sys; from scenario import migration_scenario; from transfer import Transport; print(json.dumps(migration_scenario(pathlib.Path(sys.argv[2]),Transport(sys.argv[1],'migration-fixture',sys.argv[1],'control-fixture'))))",origin,dir],{cwd:migration,env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
    expect(JSON.parse(result.stdout)).toMatchObject({scopes:4,rollbackScopes:5,closure:{references:9,unique:8},latestBytes:createHash("sha256").update("new bytes from another guest\0").digest("hex")});
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});
