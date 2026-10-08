# Surviving retries, restarts and uncertain submissions

**What it is.** The supervisor keeps jobs durable. The same request makes one job, a restart keeps provider task identities, conflicting writers in one repository take turns, and a submission whose outcome is unknown is never sent again.

**Where a person finds it.** Cloud jobs → a job's status and Receipts. A job in "Submission uncertain" offers Reconcile without resubmitting, which attaches a known cloud task ID.

**Prove it.** `pnpm exec vitest run server/laterdog/supervisor.test.ts server/laterdog/http.test.ts`. Look for: the same `requestKey` returning the same job, and different work under that key refused; independent jobs across two repositories running while a conflicting writer waits; task IDs surviving a controller restart; a crash during submission marked uncertain instead of replayed; one controller lease across two service instances.

**Not proven here.** Anything about a real provider. An uncertain job holds an execution slot until someone investigates it. A submitted native task cannot be cancelled, so a cancellation request is not proof that it stopped. A quiet provider is no reason to submit a second task.
