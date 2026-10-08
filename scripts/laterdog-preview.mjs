// Owned, disposable full-app preview. No real provider or user's application data.
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../server/laterdog/store.ts';
import { Supervisor } from '../server/laterdog/supervisor.ts';
import { createSupervisorServer } from '../server/laterdog/http.ts';
import { launchVerificationServer } from './control-laterdog.ts';
import { mountPreview } from './testing/preview-fixture.ts';
const dir=mkdtempSync(join(tmpdir(),'laterdog-preview-'));const store=new WorkspaceStore(join(dir,'workspace.sqlite'));
const supervisor=new Supervisor(store,{dataDir:dir,profiles:[{id:'default',label:'Synthetic fixture — no provider access'}],concurrency:4,publishingHost:'local'});
const token='fixture-private-token-'.repeat(3);const server=createSupervisorServer(supervisor,token);server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
const fixture=await launchVerificationServer(process.env,undefined,undefined,undefined,undefined,undefined,[],undefined,{origin,token});
const preview=await mountPreview(fixture,{entry:'/scripts/testing/threads-preview.tsx',route:'/__threads.html',title:'later.dog — isolated fixture',logLevel:'error'});
console.log(JSON.stringify({previewUrl:preview.previewUrl,harnessUrl:fixture.info.url,logPath:fixture.info.logPath,synthetic:true}));
let closed=false;
async function close(){if(closed)return;closed=true;const evidence=join(process.cwd(),'.laterdog-evidence','preview');mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'server.log'),readFileSync(fixture.info.logPath));await preview.close();await fixture.close();supervisor.stop();await supervisor.drain();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
