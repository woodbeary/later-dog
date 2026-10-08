import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WorkspaceStore } from './store.ts';
import { Supervisor } from './supervisor.ts';
import { createSupervisorServer } from './http.ts';
import { callTool, MCP_TOOLS } from './mcp.ts';
const resources: { server: Server; supervisor: Supervisor; store: WorkspaceStore; dir: string }[] = [];
afterEach(async () => { for (const r of resources.splice(0)) { r.supervisor.stop(); await r.supervisor.drain(); await new Promise<void>((resolve) => r.server.close(() => resolve())); r.store.close(); rmSync(r.dir,{ recursive:true,force:true }); } });
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'laterdog-http-')); const store=new WorkspaceStore(join(dir,'workspace.sqlite'));
  const supervisor=new Supervisor(store,{ dataDir:dir,profiles:[{id:'default',label:'Fixture'}],concurrency:4,publishingHost:'local' });
  const token='fixture-supervisor-token-'.repeat(3); const server=createSupervisorServer(supervisor,token); resources.push({ server,supervisor,store,dir });
  server.listen(0,'127.0.0.1'); await once(server,'listening'); const address=server.address(); if (!address || typeof address==='string') throw new Error('No fixture address');
  const origin=`http://127.0.0.1:${address.port}`;
  const request=(path:string,body?:unknown,auth=token,extra:Record<string,string>={})=>fetch(`${origin}/v1${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {dir,store,supervisor,token,origin,request};
}
it('drives delegation through the real MCP → HTTP → SQLite boundary with no duplicate jobs',async()=>{
  const f=await fixture(); expect((await f.request('/workspace',undefined,'wrong')).status).toBe(401);
  expect((await f.request('/workspace',undefined,f.token,{origin:'https://untrusted.example'})).status).toBe(403);
  expect((await f.request('/repositories',{slug:'fixture/repo',environmentId:'fixture-env',generation:'legacy'})).status).toBe(200);
  const brief={requestKey:randomUUID(),repository:'fixture/repo',title:'Scoped change',brief:'Exercise behavior',writeScopes:['src']};
  const first=await callTool('delegate_cloud_job',brief,f.origin,f.token) as {id:string};
  const retry=await callTool('delegate_cloud_job',brief,f.origin,f.token) as {id:string}; expect(retry.id).toBe(first.id);
  expect(f.store.jobs()).toHaveLength(1); expect(f.store.events(first.id)[0].type).toBe('created');
  await expect(callTool('delegate_cloud_job',{...brief,brief:'Different change'},f.origin,f.token)).rejects.toThrow(/different request/);
  await expect(callTool('publish_cloud_job',{jobId:first.id},f.origin,f.token)).rejects.toThrow(/remote supervisor/);
  expect(MCP_TOOLS.find(t=>t.name==='correct_cloud_job')?.description).toContain('new run');
});
it('confines a paired device to its own queued requests and refuses supervisor operations',async()=>{
  const f=await fixture(); const pairing=await (await f.request('/bridge/pairing',{roots:['/fixture/repo']})).json() as {code:string};
  const device=await (await f.request('/bridge/pair',{code:pairing.code,label:'Fixture Mac'},'')).json() as {deviceId:string;token:string};
  expect((await f.request('/workspace',undefined,device.token)).status).toBe(403);
  expect((await f.request('/jobs',{requestKey:randomUUID()},device.token)).status).toBe(403);
  const task=await (await f.request('/bridge/requests',{deviceId:device.deviceId,root:'/fixture/repo',kind:'inspect_repo'})).json() as {id:string};
  const poll=await (await f.request('/bridge/poll',{},device.token)).json() as {request:{id:string}}; expect(poll.request.id).toBe(task.id);
  expect((await f.request('/bridge/result',{id:randomUUID(),result:{},failed:false},device.token)).status).toBe(404);
  expect((await f.request('/bridge/result',{id:task.id,result:{branch:'main'},failed:false},device.token)).status).toBe(200);
  const settled=await (await f.request('/bridge/poll',{},device.token)).json() as {request:unknown}; expect(settled.request).toBeNull();
});
