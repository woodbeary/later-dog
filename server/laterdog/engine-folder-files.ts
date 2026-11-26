import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readlink, rename, rm, rmdir, symlink, link } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeWorkFolderLink, safeWorkFolderPath, WORK_FOLDER_BLOB_BYTES, type WorkFolderEntry } from "../../shared/work-folder-store.ts";
import { freeVolumeBytes, TRANSFER_SPACE_MARGIN } from "./volume-space.ts";
import { FolderStore, type FolderTree } from "./engine-folder-store.ts";

export interface FolderVisit { tree: FolderTree; stamps: Map<string, string> }
type Stat = Awaited<ReturnType<typeof statPhysical>>;
const statPhysical = (path: string) => lstat(path, {bigint: true});
const stamp = (s: Stat) => [s.dev,s.ino,s.size,s.mode,s.mtimeNs,s.ctimeNs].join(":");
const mode = (s: Stat) => Number(s.mode & 0o7777n);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
async function existing(path: string): Promise<Stat | null> {
  try { return await statPhysical(path); } catch(e) { if (missing(e)) return null; throw e; }
}

export function sameFolderEntry(a?: WorkFolderEntry, b?: WorkFolderEntry): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "dir" && b.kind === "dir") return a.mode === b.mode;
  if (a.kind === "link" && b.kind === "link") return a.target === b.target;
  return a.kind === "file" && b.kind === "file" && a.mode === b.mode && a.size === b.size && a.sha256 === b.sha256;
}

async function diskPath(folder: string, name: string): Promise<string> {
  if (!safeWorkFolderPath(name)) throw new Error("Invalid working folder path");
  let path=folder;
  for (const part of [null, ...name.split("/").slice(0,-1)]) {
    if (part !== null) path=join(path,part);
    if (!(await statPhysical(path)).isDirectory()) throw new Error("Working folder ancestor is not a directory");
  }
  return join(folder,name);
}

async function scanFile(path: string, expected: Stat, store?: FolderStore): Promise<{sha256: string; contents: string}> {
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK), hash=createHash("sha256"), chunks:string[]=[];
  try {
    if (stamp(await handle.stat({bigint:true}))!==stamp(expected)) throw new Error("Working file changed before it could be read");
    const size=Number(expected.size);
    if (!Number.isSafeInteger(size)) throw new Error("Working file size cannot be represented");
    let pos=0;
    const buffer=Buffer.allocUnsafe(Math.min(size,store?WORK_FOLDER_BLOB_BYTES:256*1024));
    while (pos<size) {
      const take=Math.min(buffer.length,size-pos);let filled=0;
      while (filled<take) {
        const {bytesRead}=await handle.read(buffer,filled,take-filled,pos+filled);
        if (!bytesRead) throw new Error("Working file shortened while reading");
        filled+=bytesRead;
      }
      const bytes=buffer.subarray(0,take);
      hash.update(bytes);
      if (store) chunks.push(await store.put("blobs",bytes));
      pos+=take;
    }
    if (stamp(await handle.stat({bigint:true}))!==stamp(expected)||stamp(await statPhysical(path))!==stamp(expected)) throw new Error("Working file changed while reading");
    return {sha256:hash.digest("hex"),contents:store?await store.pages("chunks",chunks):""};
  } finally {await handle.close();}
}

export async function visitFolder(folder:string, known?: FolderVisit):Promise<FolderVisit> {
  const root=await statPhysical(folder);
  if (!root.isDirectory()) throw new Error("Working folder is not a physical directory");
  const stamps=new Map<string,string>(),entries=new Map<string,WorkFolderEntry>();
  async function walk(at:string):Promise<void>{
    const directory=at?await diskPath(folder,at):folder;
    const names=await readdir(directory,{encoding:"buffer"});
    for (const raw of names) {
      const filename=raw.toString("utf8");
      if(!Buffer.from(filename).equals(raw))throw new Error("The working folder has a filename that cannot be represented in UTF-8");
      const name=at?at+"/"+filename:filename,path=await diskPath(folder,name),s=await statPhysical(path);
      let e:WorkFolderEntry;
      if(s.isDirectory()){e={path:name,kind:"dir",mode:mode(s)};await walk(name);}
      else if(s.isSymbolicLink()){
        const bytes=await readlink(path,{encoding:"buffer"}),target=bytes.toString("utf8");
        if(!Buffer.from(target).equals(bytes)||!safeWorkFolderLink(name,target))throw new Error("Unsafe symbolic link in working folder: "+name);
        e={path:name,kind:"link",target};
      }else if(s.isFile()){
        const cached=known?.tree.entries.get(name);
        const contents=cached?.kind==="file"&&known?.stamps.get(name)===stamp(s)?{sha256:cached.sha256,contents:cached.contents}:await scanFile(path,s);
        e={path:name,kind:"file",size:Number(s.size),mode:mode(s),...contents};
      }else throw new Error("Unsupported special file in working folder: "+name);
      entries.set(name,e);stamps.set(name,stamp(s));
    }
  }
  await walk("");
  return {tree:{mode:mode(root),entries},stamps};
}

export function mergeFolder(base:FolderTree|undefined, local:FolderTree, remote:FolderTree):FolderTree {
  const entries=new Map<string,WorkFolderEntry>();
  for(const key of new Set([...base?.entries.keys()??[],...local.entries.keys(),...remote.entries.keys()])){
    const before=base?.entries.get(key),a=local.entries.get(key),b=remote.entries.get(key);
    let chosen;
    if(sameFolderEntry(a,b)||sameFolderEntry(a,before))chosen=b;
    else if(sameFolderEntry(b,before))chosen=a;
    else throw new Error("Working folder changed on both the computer and durable storage: "+key);
    if(chosen)entries.set(key,chosen);
  }
  for(const key of entries.keys()){
    const slash=key.lastIndexOf("/");
    if(slash>=0&&entries.get(key.slice(0,slash))?.kind!=="dir")throw new Error("Working folder has conflicting changes under "+key);
  }
  const prior=base?.mode;
  const resultMode=local.mode===remote.mode||local.mode===prior||prior===undefined?remote.mode:remote.mode===prior?local.mode:undefined;
  if(resultMode===undefined)throw new Error("Working folder permissions changed on both sides");
  return {mode:resultMode,entries};
}

async function parallel<T>(values:T[], operation:(value:T)=>Promise<void>):Promise<void>{
  let n=0,failed:unknown;
  await Promise.all(Array.from({length:Math.min(6,values.length)},async()=>{
    while(!failed&&n<values.length){const value=values[n++];try{await operation(value);}catch(e){failed=e;}}
  }));
  if(failed)throw failed;
}

export async function uploadChanged(store:FolderStore, folder:string, visit:FolderVisit, tree:FolderTree, remote:FolderTree):Promise<void>{
  const changed=[...tree.entries.values()].filter(e=>e.kind==="file"&&!e.contents);
  await parallel(changed,async entry=>{
    if(entry.kind!=="file")return;
    const previous=remote.entries.get(entry.path);
    if(previous?.kind==="file"&&previous.sha256===entry.sha256&&previous.size===entry.size){entry.contents=previous.contents;return;}
    const path=await diskPath(folder,entry.path),s=await statPhysical(path);
    if(visit.stamps.get(entry.path)!==stamp(s))throw new Error("Working file changed before its checkpoint: "+entry.path);
    const scanned=await scanFile(path,s,store);
    if(scanned.sha256!==entry.sha256)throw new Error("Working file changed during its checkpoint: "+entry.path);
    entry.contents=scanned.contents;
  });
}

export function equalTree(a:FolderTree,b:FolderTree):boolean{return a.mode===b.mode&&a.entries.size===b.entries.size&&[...a.entries].every(([k,e])=>sameFolderEntry(e,b.entries.get(k)));}

export async function applyFolder(store:FolderStore,folder:string, local:FolderVisit, wanted:FolderTree):Promise<void>{
  const changed=[...wanted.entries.values()].filter(e=>!sameFolderEntry(e,local.tree.entries.get(e.path)));
  const removed=[...local.tree.entries.values()].filter(e=>!wanted.entries.has(e.path)||wanted.entries.get(e.path)?.kind!==e.kind);
  if(!changed.length&&!removed.length&&local.tree.mode===wanted.mode)return;
  const required=changed.reduce((n,e)=>n+(e.kind==="file"?e.size:0),0);
  if(required>0&&freeVolumeBytes(dirname(folder))<required+TRANSFER_SPACE_MARGIN)throw new Error("The computer has insufficient free space for the working folder update");
  const staging=await mkdtemp(join(dirname(folder),".laterdog-work-update-"));
  const material=new Map<string,string>();
  let abandoned=false;
  try{
    await parallel(changed.filter(e=>e.kind!=="dir"),async e=>{
      const tmp=join(staging,randomUUID());
      if(e.kind==="link"){
        if(!safeWorkFolderLink(e.path,e.target))throw new Error("Unsafe working folder link");
        await symlink(e.target,tmp);
      }else if(e.kind==="file"){
        const hash=createHash("sha256");let bytes=0;
        const out=await open(tmp,"wx",0o600);
        try{
          for await(const id of store.leaves(e.contents,"chunks")){
            const chunk=await store.read("blobs",id as string);bytes+=chunk.length;
            if(bytes>e.size||chunk.length===0)throw new Error("Invalid working folder file length");
            hash.update(chunk);await out.writeFile(chunk);
          }
          if(bytes!==e.size||hash.digest("hex")!==e.sha256)throw new Error("Working folder file checksum mismatch");
          await out.chmod(e.mode);await out.sync();
        }finally{await out.close();}
      }
      material.set(e.path,tmp);
    });
    for(const e of removed.sort((a,b)=>b.path.length-a.path.length)){
      const path=await diskPath(folder,e.path),s=await statPhysical(path);
      if(e.kind==="dir"){
        if(!s.isDirectory()||mode(s)!==e.mode)throw new Error("Working folder directory changed during checkout: "+e.path);
        await rmdir(path);
      }else{
        const tmp=join(staging,"former-"+randomUUID());
        await rename(path,tmp);
        const moved=await statPhysical(tmp);
        if(!(local.stamps.get(e.path)?.startsWith([moved.dev,moved.ino,moved.size,moved.mode,moved.mtimeNs].join(":")+":"))){
          try{await link(tmp,path);}catch{abandoned=true;}
          throw new Error("Working file changed during removal: "+e.path);
        }
      }
    }
    for(const e of changed.filter(e=>e.kind==="dir").sort((a,b)=>a.path.length-b.path.length)){
      const path=await diskPath(folder,e.path),s=await existing(path);
      if(!s)await mkdir(path,{mode:0o700});
      else if(!s.isDirectory()||local.tree.entries.get(e.path)?.kind!=="dir")throw new Error("Unexpected working folder directory: "+e.path);
    }
    for(const e of changed.filter(e=>e.kind!=="dir")){
      const path=await diskPath(folder,e.path),s=await existing(path);
      if(s){
        if(local.stamps.get(e.path)!==stamp(s))throw new Error("Working file changed during checkout: "+e.path);
        const backup=join(staging,"former-"+randomUUID());await rename(path,backup);
        const moved=await statPhysical(backup);
        if(moved.dev!==s.dev||moved.ino!==s.ino||moved.size!==s.size||moved.mtimeNs!==s.mtimeNs){try{await link(backup,path);}catch{abandoned=true;}throw new Error("Working file changed during replacement: "+e.path);}
        try{await link(material.get(e.path)!,path);}catch(error){try{await link(backup,path);}catch{abandoned=true;}throw error;}
      }else await link(material.get(e.path)!,path);
    }
    for(const e of changed.filter(e=>e.kind==="dir").sort((a,b)=>b.path.length-a.path.length))if(e.kind==="dir")await chmod(await diskPath(folder,e.path),e.mode);
    if(local.tree.mode!==wanted.mode)await chmod(folder,wanted.mode);
  }catch(e){abandoned=true;throw e;}finally{if(!abandoned)await rm(staging,{recursive:true,force:true});}
}

export async function publishInitialWorkFolder(folder:string,store:FolderStore) {
  const visit=await visitFolder(folder);
  await uploadChanged(store,folder,visit,visit.tree,{mode:visit.tree.mode,entries:new Map()});
  const after=await visitFolder(folder,visit);
  if(!equalTree(visit.tree,after.tree))throw new Error("The working folder changed while preparing its first durable version");
  const head=await store.publish(visit.tree,null);
  if(!head)throw new Error("Another writer has already published this working folder");
  return head;
}
