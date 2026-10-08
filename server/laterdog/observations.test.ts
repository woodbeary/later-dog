import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from './store.ts';
import { recordObservation, measuredOutcomes } from './observations.ts';
import { createJobSchema, repositorySchema } from '../../shared/laterdog.ts';
const stores:WorkspaceStore[]=[];afterEach(()=>stores.splice(0).forEach(s=>s.close()));
it('keeps missing usage unknown and deduplicates sourced outcome receipts',()=>{
 const store=new WorkspaceStore(':memory:');stores.push(store);store.saveRepository(repositorySchema.parse({slug:'fixture/repo',environmentId:'fixture'}));
 const job=store.create(createJobSchema.parse({requestKey:randomUUID(),repository:'fixture/repo',title:'Measure',brief:'Observe costs'}));
 expect(measuredOutcomes(store).reportedModelCostUsd).toBeNull();
 const receipt={requestKey:randomUUID(),jobId:job.id,kind:'usage',summary:'Provider usage statement',source:'fixture provider statement',tokens:100,modelCostUsd:0.25};
 recordObservation(store,receipt);recordObservation(store,receipt);expect(measuredOutcomes(store)).toMatchObject({reportedTokens:100,reportedModelCostUsd:0.25,reportedComputeCostUsd:null,receipts:1});
 expect(()=>recordObservation(store,{...receipt,modelCostUsd:1})).toThrow(/another receipt/);
 recordObservation(store,{requestKey:randomUUID(),jobId:job.id,kind:'intervention',summary:'Human clarified requirement',source:'source conversation'});expect(measuredOutcomes(store).interventions).toBe(1);
});
