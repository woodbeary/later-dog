import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Job } from '../../shared/laterdog.ts';
import { WorkspaceStore } from './store.ts';
import { Supervisor } from './supervisor.ts';
import { createSupervisorServer } from './http.ts';
import { callTool } from './mcp.ts';
import { CODEX_CLOUD_CAPABILITIES, type ExecutionAdapter } from './codex-cloud.ts';
import { GitHubPublisher } from './github.ts';
import type { GitHubDeviceLogin } from './github-login.ts';
import { DOG_HEADER, dogMcpEnvironment, dogToken, mcpCredential } from './dog-access.ts';
import { dogToken as workerDogToken } from '../../deploy/laterdog/cloudflare/src/dog-token.ts';

// One plain sentence a dog can repeat to its person.
const REFUSAL = /^This dog's access does not include [^\n]+\.$/;
const resources: { server: Server; supervisor: Supervisor; store: WorkspaceStore; dir: string }[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const r of resources.splice(0)) { r.supervisor.stop(); await r.supervisor.drain(); await new Promise<void>((resolve) => r.server.close(() => resolve())); r.store.close(); rmSync(r.dir,{ recursive:true,force:true }); } });
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'laterdog-dog-')); const store=new WorkspaceStore(join(dir,'workspace.sqlite'));
  // Synthetic provider and GitHub boundaries: no codex, gh or git process is ever started, and no network is reached.
  const adapter={ capabilities:CODEX_CLOUD_CAPABILITIES, submit:vi.fn(), inspect:vi.fn(), collect:vi.fn(), list:vi.fn(async()=>({tasks:[]})),
    doctor:vi.fn(async()=>({version:'fixture',authenticated:true,cloudCommands:'fixture'})), login:vi.fn(async()=>({started:true,instructions:'fixture login',startedAt:new Date().toISOString()})) } satisfies ExecutionAdapter;
  const publisher=new GitHubPublisher(join(dir,'checkouts'),async()=>{ throw new Error('fixture: no command may run'); });
  const githubAccess=vi.spyOn(publisher,'access').mockResolvedValue({authenticated:true,source:'gh-login',login:'fixture'});
  const githubLogin={ status:()=>({phase:'idle'}), start:vi.fn(async()=>({phase:'waiting',code:'ABCD-1234',url:'https://github.com/login/device'})) };
  const supervisor=new Supervisor(store,{ dataDir:dir,profiles:[{id:'default',label:'Fixture'}],concurrency:4,publishingHost:'local',adapter:()=>adapter,publisher,githubLogin:githubLogin as unknown as GitHubDeviceLogin });
  const token='fixture-admin-token-'.repeat(3); const server=createSupervisorServer(supervisor,token); resources.push({ server,supervisor,store,dir });
  server.listen(0,'127.0.0.1'); await once(server,'listening'); const address=server.address(); if (!address || typeof address==='string') throw new Error('No fixture address');
  const origin=`http://127.0.0.1:${address.port}`;
  const send=async(method:string,path:string,body:unknown,headers:Record<string,string>)=>{
    const response=await fetch(`${origin}/v1${path}`,{method,headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return { status:response.status, body:await response.json() as Record<string,unknown> & { error?:string } };
  };
  const admin=(method:string,path:string,body?:unknown)=>send(method,path,body,{authorization:`Bearer ${token}`});
  const dog=(botId:string)=>({ credential:{token:dogToken(token,botId),botId},
    send:(method:string,path:string,body?:unknown)=>send(method,path,body,{authorization:`Bearer ${dogToken(token,botId)}`,[DOG_HEADER]:botId}) });
  expect((await admin('POST','/repositories',{slug:'fixture/repo',environmentId:'fixture-env',generation:'legacy'})).status).toBe(200);
  const job=(overrides:Record<string,unknown>={})=>supervisor.create({requestKey:randomUUID(),repository:'fixture/repo',title:'Fixture',brief:'Fixture work',writeScopes:[`src/${randomUUID()}`],...overrides});
  return { dir,store,supervisor,token,origin,adapter,githubAccess,githubLogin,admin,dog,job };
}
const brief=()=>({requestKey:randomUUID(),repository:'fixture/repo',title:'Scoped change',brief:'Exercise behavior',writeScopes:[`src/${randomUUID()}`]});

it('lets a dog delegate, inspect and act on its own job through the real MCP → HTTP → SQLite boundary',async()=>{
  const f=await fixture(); const a=f.dog('dog-a');
  const request=brief(); const job=await callTool('delegate_cloud_job',request,f.origin,a.credential) as Job;
  // The supervisor assigns ownership from the token; the request named no bot.
  expect(f.store.job(job.id).botId).toBe('dog-a'); expect((await callTool('delegate_cloud_job',request,f.origin,a.credential) as Job).id).toBe(job.id); expect(f.store.jobs()).toHaveLength(1);
  expect(await callTool('inspect_cloud_job',{jobId:job.id},f.origin,a.credential)).toMatchObject({job:{id:job.id,botId:'dog-a'}});
  // Allowed through the gate; the supervisor's own preconditions answer.
  await expect(callTool('collect_cloud_diff',{jobId:job.id},f.origin,a.credential)).rejects.toThrow(/No collected diff/);
  await expect(callTool('publish_cloud_job',{jobId:job.id},f.origin,a.credential)).rejects.toThrow(/remote supervisor/);
  await expect(callTool('correct_cloud_job',{jobId:job.id,requestKey:randomUUID(),brief:'Repair it'},f.origin,a.credential)).rejects.toThrow(/Publish the result branch/);
  await expect(callTool('reconcile_cloud_task',{jobId:job.id,taskId:'task_fixture'},f.origin,a.credential)).rejects.toThrow(/uncertain or blocked/);
  expect(await callTool('record_job_observation',{requestKey:randomUUID(),jobId:job.id,kind:'decision',summary:'Chose the scope',source:'fixture'},f.origin,a.credential)).toMatchObject({jobId:job.id});
  expect(await callTool('inspect_provider_access',{profileId:'default'},f.origin,a.credential)).toMatchObject({authenticated:true});
  expect(await callTool('list_provider_tasks',{profileId:'default'},f.origin,a.credential)).toEqual({tasks:[]});
  expect(await callTool('cancel_cloud_job',{jobId:job.id},f.origin,a.credential)).toMatchObject({id:job.id,state:'cancelled'});
  // The workspace and local assistance show this dog's work and unowned work, never another dog's.
  const unowned=f.job(); const other=f.job({botId:'dog-b'});
  const workspace=await callTool('laterdog_workspace',{},f.origin,a.credential) as {jobs:Job[];repositories:unknown[]};
  expect(workspace.jobs.map((j)=>j.id).sort()).toEqual([job.id,unowned.id].sort()); expect(workspace.repositories).toHaveLength(1);
  expect(((await f.admin('GET','/workspace')).body.jobs as Job[]).map((j)=>j.id).sort()).toEqual([job.id,unowned.id,other.id].sort());
  const pairing=await f.admin('POST','/bridge/pairing',{roots:['/fixture/repo']});
  const device=await (await fetch(`${f.origin}/v1/bridge/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:pairing.body.code,label:'Fixture Mac'})})).json() as {deviceId:string};
  const local=await callTool('request_local_assistance',{deviceId:device.deviceId,root:'/fixture/repo',kind:'inspect_repo'},f.origin,a.credential) as {id:string;requestedBy:string};
  expect(local.requestedBy).toBe('dog-a');
  const theirs=(await f.dog('dog-b').send('POST','/bridge/requests',{deviceId:device.deviceId,root:'/fixture/repo',kind:'inspect_repo'})).body as {id:string};
  const operator=(await f.admin('POST','/bridge/requests',{deviceId:device.deviceId,root:'/fixture/repo',kind:'inspect_repo'})).body as {id:string};
  const seen=await callTool('inspect_local_assistance',{},f.origin,a.credential) as {devices:{id:string}[];requests:{id:string}[]};
  expect(seen.devices.map((d)=>d.id)).toEqual([device.deviceId]); expect(seen.requests.map((r)=>r.id).sort()).toEqual([local.id,operator.id].sort());
  expect(((await f.admin('GET','/bridge/devices')).body.requests as {id:string}[]).map((r)=>r.id)).toContain(theirs.id);
});

it('refuses a dog repositories, logins, verification policy, GitHub, device pairing and other jobs, in one plain sentence',async()=>{
  const f=await fixture(); const a=f.dog('dog-a');
  const own=await callTool('delegate_cloud_job',brief(),f.origin,a.credential) as Job; const other=f.job({botId:'dog-b'}); const unowned=f.job();
  const refused=async(method:string,path:string,body?:unknown,pattern=REFUSAL)=>{ const response=await a.send(method,path,body); expect(response.status,JSON.stringify(response.body)).toBe(403); expect(response.body.error).toMatch(pattern); };
  await refused('POST','/repositories',{slug:'fixture/repo',environmentId:'attacker-env',merge:true},/repositories/);
  await refused('POST','/verification-policy',{repository:'fixture/repo',behavioralChecks:['always-green'],verification:[]},/verification checks/);
  expect(f.store.repository('fixture/repo')).toMatchObject({environmentId:'fixture-env',merge:false,behavioralChecks:[]});
  await refused('POST','/profiles/default/login',{},/provider login/); expect(f.adapter.login).not.toHaveBeenCalled();
  await refused('GET','/github/access',undefined,/GitHub/); await refused('POST','/github/login',{},/GitHub/);
  expect(f.githubAccess).not.toHaveBeenCalled(); expect(f.githubLogin.start).not.toHaveBeenCalled();
  const pairing=await f.admin('POST','/bridge/pairing',{roots:['/fixture/repo']});
  const device=await (await fetch(`${f.origin}/v1/bridge/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:pairing.body.code,label:'Fixture Mac'})})).json() as {deviceId:string};
  await refused('POST','/bridge/pairing',{roots:['/']},/pairing/); await refused('DELETE',`/bridge/devices/${device.deviceId}`,undefined,/revoking/);
  await refused('POST','/bridge/poll',{},/paired device/); expect((await f.admin('GET','/bridge/devices')).body.devices).toMatchObject([{id:device.deviceId,revoked:false}]);
  await refused('GET','/whatever'); await refused('POST','/workspace',{});
  // Another dog's job is invisible; a job nobody owns can be read but not changed.
  await refused('GET',`/jobs/${other.id}`,undefined,/another dog/); await refused('GET',`/jobs/${other.id}/patch`,undefined,/another dog/);
  await refused('POST',`/jobs/${other.id}/action`,{action:'cancel'},/another dog/); expect(f.store.job(other.id).state).toBe('queued');
  expect((await a.send('GET',`/jobs/${unowned.id}`)).status).toBe(200);
  await refused('POST',`/jobs/${unowned.id}/action`,{action:'cancel'},/did not delegate/); expect(f.store.job(unowned.id).state).toBe('queued');
  // Delegation cannot borrow another dog's identity, branch or pull request.
  const jobs=f.store.jobs().length;
  await refused('POST','/jobs',{...brief(),botId:'dog-b'},/another dog/);
  await refused('POST','/jobs',{...brief(),kind:'repair',parentId:other.id},/another dog/);
  await refused('POST','/jobs',{...brief(),kind:'repair',parentId:unowned.id},/did not delegate/);
  await refused('POST','/jobs',{...brief(),dependencies:[other.id]},/another dog/);
  expect(f.store.jobs()).toHaveLength(jobs);
  await refused('POST','/observations',{requestKey:randomUUID(),jobId:other.id,kind:'regression',summary:'Blame',source:'fixture'},/another dog/);
  await refused('POST','/observations',{requestKey:randomUUID(),jobId:unowned.id,kind:'regression',summary:'Blame',source:'fixture'},/did not delegate/);
  // Through the MCP tool the model sees the same sentence.
  await expect(callTool('configure_verification_recipe',{repository:'fixture/repo',behavioralChecks:['always-green'],verification:[]},f.origin,a.credential)).rejects.toThrow(REFUSAL);
  await expect(callTool('merge_cloud_job',{jobId:other.id},f.origin,a.credential)).rejects.toThrow(REFUSAL);
  expect(f.store.job(own.id).botId).toBe('dog-a');
});

it('refuses a forged or mismatched bot id, and the admin token sent in the name of a dog',async()=>{
  const f=await fixture(); const before=f.store.jobs().length;
  const attempt=async(authorization:string,named?:string)=>{
    const response=await fetch(`${f.origin}/v1/jobs`,{method:'POST',headers:{authorization:`Bearer ${authorization}`,'content-type':'application/json',...(named===undefined?{}:{[DOG_HEADER]:named})},body:JSON.stringify(brief())});
    return response.status;
  };
  expect(await attempt(dogToken(f.token,'dog-a'),'dog-b')).toBe(401);
  expect(await attempt(f.token,'dog-a')).toBe(401);
  expect(await attempt(dogToken(f.token,'dog-a'))).toBe(401);
  expect(await attempt(dogToken('another-admin-token-'.repeat(3),'dog-a'),'dog-a')).toBe(401);
  for (const named of ['','dog a','../dog-a','x'.repeat(101),'dog-a, dog-a']) expect(await attempt(dogToken(f.token,named),named)).toBe(401);
  const headers=new Headers({authorization:`Bearer ${dogToken(f.token,'dog-a')}`}); headers.append(DOG_HEADER,'dog-a'); headers.append(DOG_HEADER,'dog-a');
  expect((await fetch(`${f.origin}/v1/workspace`,{headers})).status).toBe(401);
  const forged=await fetch(`${f.origin}/v1/workspace`,{headers:{authorization:`Bearer ${dogToken(f.token,'dog-a')}`,[DOG_HEADER]:'dog-b'}});
  expect((await forged.json() as {error:string}).error).toBe('This token is not valid for the dog it names.');
  expect(f.store.jobs()).toHaveLength(before);
});

it('keeps the admin token on every route, including other dogs’ jobs',async()=>{
  const f=await fixture(); const dogJob=f.job({botId:'dog-a'});
  expect((await f.admin('POST','/verification-policy',{repository:'fixture/repo',behavioralChecks:['integration'],verification:[]})).status).toBe(200);
  expect((await f.admin('GET','/profiles/default/access')).status).toBe(200); expect((await f.admin('POST','/profiles/default/login',{})).status).toBe(202);
  expect((await f.admin('GET','/github/access')).body).toMatchObject({authenticated:true}); expect((await f.admin('POST','/github/login',{})).status).toBe(202);
  const pairing=await f.admin('POST','/bridge/pairing',{roots:['/fixture/repo']}); expect(pairing.status).toBe(200);
  const device=await (await fetch(`${f.origin}/v1/bridge/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:pairing.body.code,label:'Fixture Mac'})})).json() as {deviceId:string};
  expect((await f.admin('DELETE',`/bridge/devices/${device.deviceId}`)).status).toBe(200);
  expect((await f.admin('GET',`/jobs/${dogJob.id}`)).status).toBe(200);
  expect((await f.admin('POST',`/jobs/${dogJob.id}/action`,{action:'cancel'})).body).toMatchObject({state:'cancelled'});
  // The admin MCP path (no bot ID) is unchanged: its jobs carry no owner unless the request names one.
  const job=await callTool('delegate_cloud_job',brief(),f.origin,f.token) as Job; expect(f.store.job(job.id).botId).toBeUndefined();
  expect((await f.admin('GET','/workspace')).body.jobs).toHaveLength(2);
});

it('derives one dog token on the desktop, the supervisor and the Cloudflare Worker, and keeps the admin token out of a dog’s MCP environment',async()=>{
  const admin='fixture-admin-token-'.repeat(3); const bot=randomUUID();
  const token=dogToken(admin,bot); expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(token).not.toBe(admin);
  for (const id of [bot,'dog-a','dog_b-2']) expect(await workerDogToken(admin,id)).toBe(dogToken(admin,id));
  expect(dogToken(admin,'dog-a')).not.toBe(dogToken(admin,'dog-b')); expect(dogToken(`${admin}x`,'dog-a')).not.toBe(dogToken(admin,'dog-a'));
  vi.stubEnv('LATERDOG_SUPERVISOR_URL','https://supervisor.example.test'); vi.stubEnv('LATERDOG_TOKEN',admin);
  const env=dogMcpEnvironment(bot,'thread-1');
  expect(env).toEqual({LATERDOG_SUPERVISOR_URL:'https://supervisor.example.test',LATERDOG_TOKEN:token,LATERDOG_BOT_ID:bot,LATERDOG_CONVERSATION_ID:'thread-1'});
  expect(JSON.stringify(env)).not.toContain(admin);
  expect(mcpCredential(env)).toEqual({token,botId:bot});
  // A dog's MCP server without its token fails plainly instead of reading the admin token from a file.
  const dir=mkdtempSync(join(tmpdir(),'laterdog-dog-credential-')); const tokenFile=join(dir,'access-token'); writeFileSync(tokenFile,admin);
  try { expect(()=>mcpCredential({LATERDOG_BOT_ID:bot,LATERDOG_TOKEN_FILE:tokenFile,LATERDOG_DATA_DIR:dir})).toThrow(/no later\.dog token/); }
  finally { rmSync(dir,{recursive:true,force:true}); }
  // Without a bot ID it is the operator's server, presenting the admin token it is configured with (here LATERDOG_TOKEN).
  expect(mcpCredential({})).toEqual({token:admin});
});
