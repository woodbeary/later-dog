import { expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from './store.ts';
import { Supervisor } from './supervisor.ts';
import { createSupervisorServer } from './http.ts';
import { deliverOutbox } from './notifications.ts';
import { launchVerificationServer, runControlLaterDog } from '../../scripts/control-laterdog.ts';
it('connects the authenticated workspace proxy and sends durable completion into the pinned real conversation fixture',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'laterdog-conversation-')); const store=new WorkspaceStore(join(dir,'state.sqlite'));
 const supervisor=new Supervisor(store,{dataDir:dir,profiles:[{id:'default',label:'Fixture'}],concurrency:4,publishingHost:'local'});
 const token='fixture-token-'.repeat(4); const server=createSupervisorServer(supervisor,token);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture port');
 const origin=`http://127.0.0.1:${address.port}`;let harness:Awaited<ReturnType<typeof launchVerificationServer>>|undefined;
 const evidence=join(process.cwd(),'.laterdog-evidence','conversation');mkdirSync(evidence,{recursive:true});
 try {
   harness=await launchVerificationServer(process.env,undefined,undefined,undefined,undefined,undefined,[],undefined,{origin,token});
   const request=async(path:string,body?:unknown)=>{const response=await fetch(`${harness!.info.url}${path}`,{method:body===undefined?'GET':'POST',headers:{origin:harness!.info.url,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();expect(response.ok,JSON.stringify(result)).toBe(true);return result;};
   const doctor=await runControlLaterDog(['doctor','--url',harness.info.url]);expect(doctor).toMatchObject({ok:true});
   const bots=await request('/api/bots') as {bots:{id:string;threadId:string}[]};const bot=bots.bots[0];
   await request('/api/laterdog/repositories',{slug:'fixture/repo',environmentId:'synthetic-cloud',generation:'unqualified'});
   const job=await request('/api/laterdog/jobs',{requestKey:randomUUID(),repository:'fixture/repo',title:'Verify callback',brief:'Synthetic provider completion',botId:bot.id,conversationId:bot.threadId}) as {id:string};
   expect(store.jobs()).toHaveLength(1);store.update(job.id,{state:'ready'},'collected','Synthetic diff retained');
   await deliverOutbox(store,harness.info.url);await deliverOutbox(store,harness.info.url);
   const settled=await runControlLaterDog(['wait','--url',harness.info.url,'--bot',bot.id,'--task',bot.threadId,'--timeout','20']);
   const messages=await runControlLaterDog(['messages','--url',harness.info.url,'--bot',bot.id,'--task',bot.threadId]);
   const serialized=JSON.stringify(messages);expect(serialized).toContain(`later.dog job ${job.id}: collected`);
   const rows=store.db.prepare('SELECT delivered FROM outbox').all() as {delivered:number}[];expect(rows.every(r=>r.delivered===1)).toBe(true);
   writeFileSync(join(evidence,'receipts.json'),JSON.stringify({doctor,job,settled,messages,logPath:harness.info.logPath},null,2));
 } finally {
   if(harness){writeFileSync(join(evidence,'server.log'),readFileSync(harness.info.logPath));await harness.close();}
   supervisor.stop();await supervisor.drain();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(dir,{recursive:true,force:true});
 }
 expect(existsSync(join(evidence,'receipts.json'))).toBe(true);
},60_000);

it('pulls wake-ups from a supervisor that cannot call the desktop, and wakes the pinned real conversation fixture',async()=>{
 // A hosted supervisor has no route into this machine: nothing here calls deliverOutbox. The desktop server pulls on its own.
 const dir=mkdtempSync(join(tmpdir(),'laterdog-pull-')); const store=new WorkspaceStore(join(dir,'state.sqlite'));
 const supervisor=new Supervisor(store,{dataDir:dir,profiles:[{id:'default',label:'Fixture'}],concurrency:4,publishingHost:'remote'});
 const token='fixture-token-'.repeat(4); const server=createSupervisorServer(supervisor,token);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture port');
 const origin=`http://127.0.0.1:${address.port}`;let harness:Awaited<ReturnType<typeof launchVerificationServer>>|undefined;
 const evidence=join(process.cwd(),'.laterdog-evidence','conversation-pull');mkdirSync(evidence,{recursive:true});
 try {
   harness=await launchVerificationServer(process.env,undefined,undefined,undefined,undefined,undefined,[],undefined,{origin,token,wakeupPullMs:300});
   const request=async(path:string,body?:unknown)=>{const response=await fetch(`${harness!.info.url}${path}`,{method:body===undefined?'GET':'POST',headers:{origin:harness!.info.url,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();expect(response.ok,JSON.stringify(result)).toBe(true);return result;};
   const bots=await request('/api/bots') as {bots:{id:string;threadId:string}[]};const bot=bots.bots[0];
   await request('/api/laterdog/repositories',{slug:'fixture/repo',environmentId:'synthetic-cloud',generation:'unqualified'});
   const job=await request('/api/laterdog/jobs',{requestKey:randomUUID(),repository:'fixture/repo',title:'Verify pulled callback',brief:'Synthetic provider completion',botId:bot.id,conversationId:bot.threadId}) as {id:string};
   // The workspace says wake-ups reach this desktop although the supervisor itself has no workspace URL.
   expect((await request('/api/laterdog/workspace') as {wakeupsConfigured:boolean}).wakeupsConfigured).toBe(true);
   store.update(job.id,{state:'ready'},'collected','Synthetic diff retained');
   const deadline=Date.now()+20_000;let delivered:{delivered:number}[]=[];
   while(Date.now()<deadline){delivered=store.db.prepare('SELECT delivered FROM outbox').all() as {delivered:number}[];if(delivered.length&&delivered.every(r=>r.delivered===1))break;await new Promise(r=>setTimeout(r,200));}
   expect(delivered).toEqual([{delivered:1}]);
   const settled=await runControlLaterDog(['wait','--url',harness.info.url,'--bot',bot.id,'--task',bot.threadId,'--timeout','20']);
   const messages=await runControlLaterDog(['messages','--url',harness.info.url,'--bot',bot.id,'--task',bot.threadId]);
   const serialized=JSON.stringify(messages);expect(serialized).toContain(`later.dog job ${job.id}: collected`);
   // Delivered once: later pulls find nothing, and the send id would make any repeat harmless.
   await new Promise(r=>setTimeout(r,1_000));
   expect(serialized.split(`later.dog job ${job.id}: collected`).length-1).toBe(1);
   expect(JSON.stringify(await runControlLaterDog(['messages','--url',harness.info.url,'--bot',bot.id,'--task',bot.threadId])).split(`later.dog job ${job.id}: collected`).length-1).toBe(1);
   writeFileSync(join(evidence,'receipts.json'),JSON.stringify({job,settled,messages,logPath:harness.info.logPath},null,2));
 } finally {
   if(harness){writeFileSync(join(evidence,'server.log'),readFileSync(harness.info.logPath));await harness.close();}
   supervisor.stop();await supervisor.drain();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(dir,{recursive:true,force:true});
 }
 expect(existsSync(join(evidence,'receipts.json'))).toBe(true);
},60_000);
