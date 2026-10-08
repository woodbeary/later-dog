import { z } from 'zod';
import { WorkspaceStore } from './store.ts';
export const observationSchema=z.object({requestKey:z.string().min(8).max(200),jobId:z.string().uuid(),kind:z.enum(['decision','intervention','regression','usage']),summary:z.string().min(1).max(20_000),source:z.string().min(1).max(500),evidenceRef:z.string().max(2000).optional(),model:z.string().max(100).optional(),tokens:z.number().int().nonnegative().optional(),modelCostUsd:z.number().nonnegative().optional(),computeCostUsd:z.number().nonnegative().optional()}).strict();
export type Observation=z.infer<typeof observationSchema> & {at:string};
export function recordObservation(store:WorkspaceStore,input:unknown):Observation {
 const value=observationSchema.parse(input);store.job(value.jobId);
 return store.transaction(()=>{
  const prior=store.db.prepare('SELECT document FROM observations WHERE request_key=?').get(value.requestKey) as {document:string}|undefined;
  if(prior){const existing=JSON.parse(prior.document) as Observation;const {at:_at,...brief}=existing;if(JSON.stringify(brief)!==JSON.stringify(value))throw new Error('Observation requestKey belongs to another receipt');return existing;}
  const observation={...value,at:new Date().toISOString()};store.db.prepare('INSERT INTO observations VALUES(?,?)').run(value.requestKey,JSON.stringify(observation));return observation;
 });
}
export function measuredOutcomes(store:WorkspaceStore){
 const observations=(store.db.prepare('SELECT document FROM observations ORDER BY rowid DESC').all() as {document:string}[]).map(r=>JSON.parse(r.document) as Observation);
 const sum=(field:'tokens'|'modelCostUsd'|'computeCostUsd')=>{const values=observations.filter(o=>o.kind==='usage'&&o[field]!==undefined).map(o=>o[field]!);return values.length?values.reduce((a,b)=>a+b,0):null;};
 const completions=store.jobs().flatMap(job=>{const row=store.db.prepare("SELECT MIN(at) AS completed FROM events WHERE job_id=? AND type='collected'").get(job.id) as {completed:string|null};return row.completed?[Date.parse(row.completed)-Date.parse(job.createdAt)]:[];});
 return {interventions:observations.filter(o=>o.kind==='intervention').length,regressions:observations.filter(o=>o.kind==='regression').length,reportedTokens:sum('tokens'),reportedModelCostUsd:sum('modelCostUsd'),reportedComputeCostUsd:sum('computeCostUsd'),averageObservedCompletionMs:completions.length?Math.round(completions.reduce((a,b)=>a+b,0)/completions.length):null,receipts:observations.length,coverage:'Reported usage receipts only; unavailable provider usage and cost remain unknown.'};
}
