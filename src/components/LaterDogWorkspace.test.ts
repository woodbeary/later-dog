// @vitest-environment happy-dom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { LaterDogWorkspace } from './LaterDogWorkspace';
import type { WorkspaceSnapshot } from '../../shared/laterdog';
let root:Root; let host:HTMLDivElement;
afterEach(async()=>{ if(root) await act(async()=>root.unmount()); host?.remove(); vi.unstubAllGlobals(); });
const snapshot:WorkspaceSnapshot={jobs:[],repositories:[],profiles:[{id:'default',label:'Fixture'}],backends:[],concurrency:4,active:0,publishingHost:'local',wakeupsConfigured:false,metrics:{prOpened:0,verified:0,merged:0,needsAttention:0,repairs:0}};
async function mount(value:WorkspaceSnapshot|{error:string},status=200){
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes('/jobs/') ? {events:[]} : value),{status,headers:{'content-type':'application/json'}})));
  host=document.createElement('div'); document.body.append(host); root=createRoot(host);
  await act(async()=>{root.render(createElement(LaterDogWorkspace));});
}
it('renders honest empty state and separates verified from merged results',async()=>{
  await mount(snapshot); expect(host.textContent).toContain('Connect a repository'); expect(host.textContent).toContain('PRs verified'); expect(host.textContent).toContain('PRs merged');
  const button=Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Delegate work'); expect(button?.disabled).toBe(true);
  expect(host.textContent).toContain('2,500 PRs a month is a capacity target'); expect(host.textContent).toContain('Agent wakeups: not configured');
});
it('renders an actionable connection failure instead of fabricated counts',async()=>{
  await mount({error:'Remote supervisor unavailable'},503); expect(host.querySelector('[role=alert]')?.textContent).toContain('Remote supervisor unavailable'); expect(host.querySelector('dl')).toBeNull();
});
it('shows uncertain submissions and keeps unsupported publication disabled',async()=>{
  const job={id:crypto.randomUUID(),requestKey:crypto.randomUUID(),repository:'fixture/repo',title:'Recover uncertain task',brief:'Keep provider identity',standingInstructions:'',writeScopes:['src'],dependencies:[],profileId:'default',kind:'implementation' as const,state:'submission_unknown' as const,backend:'codex-cloud' as const,attempt:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),outputBranch:'laterdog/fixture'};
  await mount({...snapshot,jobs:[job],active:1}); const row=host.querySelector('[aria-label="Delegated jobs"] button') as HTMLButtonElement;
  await act(async()=>row.click()); expect(host.textContent).toContain('Submission uncertain'); expect(host.textContent).toContain('Reconcile without resubmitting');
  expect(Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Publish PR')?.disabled).toBe(true);
});
