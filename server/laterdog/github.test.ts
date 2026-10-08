import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitHubPublisher } from './github.ts';
import { runCommand, requireSuccess, type CommandRunner, type CommandResult } from './command.ts';
import { createJobSchema, repositorySchema, type Job } from '../../shared/laterdog.ts';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const ok=(stdout:string):CommandResult=>({stdout,stderr:'',exitCode:0,timedOut:false});
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'laterdog-git-'));dirs.push(dir); const work=join(dir,'source');mkdirSync(work);
  const git=async(cwd:string,args:string[])=>requireSuccess(await runCommand('git',['-c','core.hooksPath=/dev/null',...args],{cwd}),'Fixture Git');
  await git(work,['init','-b','main']);await git(work,['config','user.email','fixture@example.invalid']);await git(work,['config','user.name','Fixture']);mkdirSync(join(work,'src'));writeFileSync(join(work,'src/a.txt'),'old\n');await git(work,['add','.']);await git(work,['commit','-m','Fixture base']);
  const baseSha=await git(work,['rev-parse','HEAD']);const remote=join(dir,'remote.git');await git(dir,['clone','--bare',work,remote]);
  const id=randomUUID();const job:Job={...createJobSchema.parse({requestKey:randomUUID(),repository:'fixture/repo',title:'Change behavior',brief:'new value',writeScopes:['src']}),id,state:'ready',backend:'codex-cloud',attempt:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),outputBranch:`laterdog/${id}`,sourceRef:`laterdog/input/${id}`,baseSha};
  await git(remote,['update-ref',`refs/heads/${job.sourceRef}`,baseSha]);
  let pr: {number:number;url:string;headRefOid:string;state:string}|undefined;let created=0;let uncertain=false;let failClone=false;
  const runner:CommandRunner=async(binary,args,options)=>{
    if(binary!=='gh')return runCommand(binary,args,options);
    if(args[0]==='repo'&&args[1]==='clone'){
      if(failClone){failClone=false;return {...ok(''),stderr:'fatal: could not read from remote repository',exitCode:128};}
      return runCommand('git',['clone','--no-checkout',remote,args[3]]);
    }
    if(args[0]==='pr'&&args[1]==='list')return ok(JSON.stringify(pr?[pr]:[]));
    if(args[0]==='pr'&&args[1]==='create'){
      created++;pr={number:1,url:'https://github.com/fixture/repo/pull/1',headRefOid:await git(remote,['rev-parse',job.outputBranch]),state:'OPEN'};
      if(uncertain)return {...ok(''),exitCode:1};return ok(pr.url);
    }
    if(args[0]==='pr'&&args[1]==='view')return ok(JSON.stringify({...pr,headRefOid:await git(remote,['rev-parse',job.outputBranch])}));
    throw new Error(`Unexpected fixture command ${args.join(' ')}`);
  };
  return {dir,remote,job,git,publisher:new GitHubPublisher(join(dir,'checkouts'),runner),repo:repositorySchema.parse({slug:'fixture/repo',environmentId:'fixture'}),created:()=>created,uncertain:()=>{uncertain=true;},failNextClone:()=>{failClone=true;}};
}
const patch='diff --git a/src/a.txt b/src/a.txt\nindex 3367afd..3e75765 100644\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
it('reports GitHub access the way publishing will use it, without reading the credential',async()=>{
  const calls:string[][]=[];
  const runner:CommandRunner=async(binary,args)=>{calls.push([binary,...args]);return args[1]==='user'&&process.env.GH_TOKEN?ok('woodbeary\n'):{...ok(''),stderr:'gh: To get started with GitHub CLI, please run:  gh auth login\nsecret-looking-value-must-not-leak',exitCode:4};};
  const publisher=new GitHubPublisher(join(tmpdir(),'unused'),runner);
  const before=process.env.GH_TOKEN;delete process.env.GH_TOKEN;
  try {
    const signedOut=await publisher.access();expect(signedOut.authenticated).toBe(false);expect(signedOut.source).toBe('gh-login');expect(signedOut.detail).toContain('Connect GitHub');expect(signedOut.detail).toContain('gh auth login');
    process.env.GH_TOKEN='placeholder-for-the-fixture-only';
    expect(await publisher.access()).toEqual({authenticated:true,source:'GH_TOKEN',login:'woodbeary'});
    expect(calls.every(([binary,sub,resource])=>binary==='gh'&&sub==='api'&&resource==='user')).toBe(true);
  } finally {if(before===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=before;}
});
it('publishes from a real isolated Git checkout and reconciles a PR accepted before a lost response',async()=>{
  const f=await fixture();f.uncertain();await expect(f.publisher.publish(f.job,f.repo,patch)).rejects.toThrow(/Open draft PR failed/);
  const recovered=await f.publisher.publish(f.job,f.repo,patch);expect(f.created()).toBe(1);expect(recovered.prNumber).toBe(1);
  expect(await f.git(f.remote,['show',`${f.job.outputBranch}:src/a.txt`])).toBe('new');expect(recovered.headSha).not.toBe(f.job.baseSha);
  expect(readFileSync(join(f.dir,'source','src/a.txt'),'utf8')).toBe('old\n');
  const body=readFileSync(join(f.dir,'checkouts',`${f.job.id}-pr.md`),'utf8');expect(body).not.toContain(f.job.brief);expect(body).toContain(f.job.title);
});
it('recovers a staged patch after interruption without applying it twice',async()=>{
  const f=await fixture();const dir=join(f.dir,'checkouts',f.job.id);mkdirSync(join(f.dir,'checkouts'));
  await f.git(f.dir,['clone','--no-checkout',f.remote,dir]);await f.git(dir,['checkout','-b',f.job.outputBranch,f.job.baseSha!]);
  const artifact=join(f.dir,'change.patch');writeFileSync(artifact,patch);await f.git(dir,['apply','--index',artifact]);
  const result=await f.publisher.publish(f.job,f.repo,patch);expect(result.prNumber).toBe(1);expect(await f.git(f.remote,['show',`${f.job.outputBranch}:src/a.txt`])).toBe('new');
});
it('publishes a collected diff whose trailing newline was stripped',async()=>{
  const f=await fixture();const result=await f.publisher.publish(f.job,f.repo,patch.trimEnd());
  expect(result.prNumber).toBe(1);expect(await f.git(f.remote,['show',`${f.job.outputBranch}:src/a.txt`])).toBe('new');
});
it('removes a half-built checkout after a failed clone so the retry succeeds and reports the Git error',async()=>{
  const f=await fixture();f.failNextClone();
  await expect(f.publisher.publish(f.job,f.repo,patch)).rejects.toThrow(/Clone publishing checkout failed \(exit 128\): fatal: could not read/);
  expect(existsSync(join(f.dir,'checkouts',f.job.id))).toBe(false);
  const result=await f.publisher.publish(f.job,f.repo,patch);expect(result.prNumber).toBe(1);expect(f.created()).toBe(1);
});
it('blocks changes outside the declared scopes before pushing',async()=>{
  const f=await fixture();f.job.writeScopes=['other'];await expect(f.publisher.publish(f.job,f.repo,patch)).rejects.toThrow(/exceed/);
  expect(await f.git(f.remote,['for-each-ref','--format=%(refname)',`refs/heads/${f.job.outputBranch}`])).toBe('');expect(f.created()).toBe(0);
});
it('voids verification when the live PR head changes while checks are being collected',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'laterdog-evidence-'));dirs.push(dir);let reads=0;const head='a'.repeat(40);
  const run:CommandRunner=async(_binary,args)=>{
    if(args[0]==='pr')return ok(JSON.stringify({state:"OPEN",headRefOid:++reads===1?head:'b'.repeat(40)}));
    if(args[1].includes('check-runs'))return ok(JSON.stringify({total_count:1,check_runs:[{name:'behavior',status:'completed',conclusion:'success',html_url:'https://fixture.invalid/check'}]}));
    return ok(JSON.stringify({statuses:[]}));
  };
  const publisher=new GitHubPublisher(join(dir,'checkouts'),run);const job={id:randomUUID(),repository:'fixture/repo',prNumber:1} as Job;
  const result=await publisher.verify(job,repositorySchema.parse({slug:'fixture/repo',environmentId:'fixture'}),dir);
  expect(result.verdict).toBe('blocked');expect(JSON.parse(readFileSync(result.evidence,'utf8')).headSha).toBe(head);
});
it('treats truncated check evidence as blocked',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'laterdog-evidence-'));dirs.push(dir);
  const run:CommandRunner=async(_binary,args)=>ok(JSON.stringify(args[0]==='pr'?{state:'OPEN',headRefOid:'a'.repeat(40)}:args[1].includes('check-runs')?{total_count:101,check_runs:[{name:'test',status:'completed',conclusion:'success'}]}:{statuses:[]}));
  const result=await new GitHubPublisher(dir,run).verify({id:randomUUID(),repository:'fixture/repo',prNumber:1} as Job,repositorySchema.parse({slug:'fixture/repo',environmentId:'fixture'}),dir);expect(result.verdict).toBe('blocked');
});

it('does not count a lint-only green check as behavioral verification',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'laterdog-evidence-'));dirs.push(dir);
  const run:CommandRunner=async(_binary,args)=>ok(JSON.stringify(args[0]==='pr'?{state:'OPEN',headRefOid:'a'.repeat(40)}:args[1].includes('check-runs')?{total_count:1,check_runs:[{name:'lint',status:'completed',conclusion:'success'}]}:{statuses:[]}));
  const publisher=new GitHubPublisher(dir,run);const job={id:randomUUID(),repository:'fixture/repo',prNumber:1} as Job;
  const result=await publisher.verify(job,repositorySchema.parse({slug:'fixture/repo',environmentId:'fixture'}),dir);expect(result.verdict).toBe('blocked');
});
it('accepts an explicitly configured behavioral check at the current commit',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'laterdog-evidence-'));dirs.push(dir);
  const run:CommandRunner=async(_binary,args)=>ok(JSON.stringify(args[0]==='pr'?{state:'OPEN',headRefOid:'a'.repeat(40)}:args[1].includes('check-runs')?{total_count:2,check_runs:[{name:'browser-acceptance',status:'completed',conclusion:'success'},{name:'optional',status:'completed',conclusion:'skipped'}]}:{statuses:[]}));
  const result=await new GitHubPublisher(dir,run).verify({id:randomUUID(),repository:'fixture/repo',prNumber:1} as Job,repositorySchema.parse({slug:'fixture/repo',environmentId:'fixture',behavioralChecks:['browser-acceptance']}),dir);expect(result.verdict).toBe('passed');
});
