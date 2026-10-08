import { expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from './store.ts';
import { Supervisor } from './supervisor.ts';
import { createSupervisorServer } from './http.ts';
import { CODEX_CLOUD_CAPABILITIES } from './codex-cloud.ts';
import { dogToken } from './dog-access.ts';
import { launchVerificationServer } from '../../scripts/control-laterdog.ts';

interface ToolResult { isError?: boolean; content: { text: string }[] }
interface McpLaunch { command: string; args: string[]; env: Record<string, string> }

it('starts a real conversation’s laterdog MCP server with that dog’s own token, never the admin token, and the token is scoped',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'laterdog-dog-e2e-')); const home=mkdtempSync(join(tmpdir(),'laterdog-dog-home-'));
  const store=new WorkspaceStore(join(dir,'state.sqlite'));
  // A synthetic provider: nothing is submitted anywhere, and the supervisor never ticks.
  const supervisor=new Supervisor(store,{dataDir:dir,profiles:[{id:'default',label:'Fixture'}],concurrency:4,publishingHost:'local',
    adapter:()=>({capabilities:CODEX_CLOUD_CAPABILITIES,submit:async()=>{ throw new Error('fixture: no submission'); },inspect:async()=>'running' as const,collect:async()=>'',list:async()=>({tasks:[]})})});
  const token='fixture-admin-token-'.repeat(3); const server=createSupervisorServer(supervisor,token); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); if (!address || typeof address==='string') throw new Error('No fixture port');
  const origin=`http://127.0.0.1:${address.port}`;
  let harness: Awaited<ReturnType<typeof launchVerificationServer>> | undefined; let mcp: ChildProcess | undefined; let stderr='';
  try {
    harness=await launchVerificationServer(process.env,undefined,undefined,undefined,undefined,undefined,[],undefined,{origin,token});
    const url=harness.info.url;
    const api=async(path:string,body?:unknown)=>{
      const response=await fetch(`${url}${path}`,{method:body===undefined?'GET':'POST',headers:{origin:url,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const result=await response.json(); expect(response.ok,JSON.stringify(result)).toBe(true); return result;
    };
    const bot=(await api('/api/bots') as {bots:{id:string;threadId:string}[]}).bots[0];
    // The desktop's own Workspace proxy keeps the admin token.
    await api('/api/laterdog/repositories',{slug:'fixture/repo',environmentId:'synthetic-cloud',generation:'unqualified'});
    const otherDogs=supervisor.create({requestKey:randomUUID(),repository:'fixture/repo',title:'Another dog',brief:'Not yours',writeScopes:['docs'],botId:'another-dog'});
    await api(`/api/bots/${bot.id}/messages`,{text:'Check on the cloud jobs.'});
    const dump=await vi.waitFor(()=>{
      const parsed=JSON.parse(readFileSync(harness!.fixtureDumpPath,'utf8')) as {mcpConfig?:{mcpServers?:{laterdog?:McpLaunch}}};
      if (!parsed.mcpConfig?.mcpServers?.laterdog) throw new Error('The fake engine has not received a laterdog MCP server yet');
      return parsed as {mcpConfig:{mcpServers:{laterdog:McpLaunch}}};
    },{timeout:30_000,interval:200});
    // The harness mounts each MCP server behind its gate (server/mcp-gate.ts), which carries the upstream launch privately.
    const mounted=dump.mcpConfig.mcpServers.laterdog;
    const upstream=mounted.env.LATERDOG_GATE_UPSTREAM ? JSON.parse(mounted.env.LATERDOG_GATE_UPSTREAM) as McpLaunch : mounted;
    expect(upstream.args.at(-1)).toMatch(/server\/laterdog\/mcp\.ts$/);
    expect(upstream.env).toEqual({LATERDOG_SUPERVISOR_URL:origin,LATERDOG_TOKEN:dogToken(token,bot.id),LATERDOG_BOT_ID:bot.id,LATERDOG_CONVERSATION_ID:bot.threadId});
    // Not in the engine's argv, its environment, its prompt or any MCP server's configuration.
    const holding=(value:unknown,path:string):string[]=>typeof value==='string' ? (value.includes(token) ? [path] : [])
      : value && typeof value==='object' ? Object.entries(value).flatMap(([key,child])=>holding(child,`${path}.${key}`)) : [];
    expect(holding(dump,'engine')).toEqual([]);
    // Start it as the engine does, gate included, in an empty home with no token file to fall back on.
    mcp=spawn(mounted.command,mounted.args,{env:{PATH:process.env.PATH,HOME:home,...mounted.env},stdio:['pipe','pipe','pipe']});
    mcp.stderr!.on('data',(chunk)=>{ stderr+=String(chunk); });
    const waiting=new Map<number,(message:{result:ToolResult})=>void>(); let next=0;
    createInterface({input:mcp.stdout!}).on('line',(line)=>{ const message=JSON.parse(line) as {id:number;result:ToolResult}; waiting.get(message.id)?.(message); waiting.delete(message.id); });
    const call=(name:string,args:unknown)=>new Promise<ToolResult>((resolve,reject)=>{
      const id=++next; const timer=setTimeout(()=>reject(new Error(`${name} did not answer: ${stderr.slice(-500)}`)),20_000);
      waiting.set(id,(message)=>{ clearTimeout(timer); resolve(message.result); });
      mcp!.stdin!.write(`${JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})}\n`);
    });
    const delegated=await call('delegate_cloud_job',{requestKey:randomUUID(),repository:'fixture/repo',title:'Dog job',brief:'Synthetic work',writeScopes:['src']});
    expect(delegated.isError,delegated.content[0].text).toBeFalsy();
    const job=JSON.parse(delegated.content[0].text) as {id:string};
    expect(store.job(job.id)).toMatchObject({botId:bot.id,conversationId:bot.threadId});
    const policy=await call('configure_verification_recipe',{repository:'fixture/repo',behavioralChecks:['always-green'],verification:[]});
    expect(policy.isError).toBe(true); expect(policy.content[0].text).toMatch(/^This dog's access does not include [^\n]+\.$/);
    expect(store.repository('fixture/repo').behavioralChecks).toEqual([]);
    const foreign=await call('inspect_cloud_job',{jobId:otherDogs.id});
    expect(foreign.isError).toBe(true); expect(foreign.content[0].text).toBe("This dog's access does not include jobs another dog delegated.");
    const cancelled=await call('cancel_cloud_job',{jobId:job.id});
    expect(JSON.parse(cancelled.content[0].text)).toMatchObject({id:job.id,state:'cancelled'});
  } finally {
    mcp?.stdin?.end(); mcp?.kill();
    await harness?.close();
    supervisor.stop(); await supervisor.drain(); await new Promise<void>((resolve)=>server.close(()=>resolve())); store.close();
    rmSync(dir,{recursive:true,force:true}); rmSync(home,{recursive:true,force:true});
  }
},90_000);
