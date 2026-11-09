# Optional execution advice

Dogs can call `execution_advice` with a bounded task description. The tool reads
only that dog's usage history over the last thirty days and lists available model
candidates, standard API list prices with source dates, execution observations,
coverage gaps and bounded evidence references. It does not change account, model,
effort, dispatch, prompts or native orchestration. It makes no external inference
call and requires no new credential.

The route is `POST /api/internal/execution-advice`, authenticated by the existing
agents turn capability. Another dog's history is excluded. Shared and guest-driven work is limited to
the current thread; only owner work can inspect the dog's other threads. Expired capabilities
are rejected. The advisor adds no task text to usage evidence or its own persistent store. Existing conversation/engine tool traces may retain arguments and results under their existing retention rules.

## Ownership

Two designs were considered. Dispatch-owned routing would put recommendation and
selection in the same path, duplicate engine orchestration and risk overriding an
explicit model selection. Server-owned evidence with a read-only advisory tool
keeps the ledger as the single writer and makes a failed or repeated advice call
harmless. The latter is implemented in `server/laterdog/execution-evidence.ts`,
`server/laterdog/execution-advisor.ts` and the small internal route adapter.

At dispatch the server freezes selected and dispatched model/effort. Session events
can add the provider-reported model. Completion records the turn identity,
execution duration, provider success and unverified task status in the existing
usage ledger. A conflicting provider is marked and its model attribution becomes
unknown. Old rows are not backfilled with invented attribution. Malformed optional
metadata is discarded without losing the original usage row.

New ledger execution metadata excludes task and prompt fields. `parseExecutionEvidence` whitelists the
evidence fields, including the selected and dispatched effort, variant and fast
settings, on every append and every read, so a legacy `execution.task` or any
unknown field is dropped from what the server returns while valid usage and
selection metadata stay. The reader does not rewrite files: month files written
before this change still hold their old task titles at rest. They are neither
scrubbed nor deleted here, and removing them is a separate, explicit step.

Admins can monitor the last thirty days through the read-only
`GET /api/usage/executions?limit=50` endpoint (maximum 200 receipts). It excludes
trigger email addresses and rejects non-admin callers. This supports passive
production verification without sending synthetic requests to live dogs.

## Run

Use Node 24 or newer and pnpm:

```sh
pnpm exec vitest run server/laterdog/execution-evidence.test.ts server/laterdog/execution-advisor.test.ts server/execution-advisor.e2e.test.ts server/usage-ledger.test.ts server/model-prices.test.ts server/agent-tool-policy.test.ts server/routes/execution-advice.test.ts server/drivers/agents-proxy.test.ts server/drivers/agents-catalog-wire.test.ts
pnpm typecheck
pnpm lint
```

The end-to-end test launches the standard isolated verification server and fake
engine, sends a fixture task through `control-laterdog`, invokes the actual agents
tool using the fixture's own active capability, checks privacy and selection
preservation, stops that fixture task, checks its ledger evidence and rejects the
expired capability. No live account, dog, browser or provider receives a mutation.

Evidence survives fixture cleanup in
`.laterdog-evidence/execution-advisor/receipt.json` and `server.log`. The receipt
contains the recommendation, coverage, selected model before/after, the recorded
execution and capability expiry status. It excludes capability tokens.

## Recorded verification (2026-11-08)

The nine-file suite passed 190 checks, including an HTTP route check that proves
shared and guest-driven history isolation. The existing isolated account
continuation suite passed all 17 scenarios. A further targeted cross-engine
regression confirms that the chosen Claude selection stays recorded while Codex
actually dispatches the chosen fallback model. The tool fixture passed privacy,
selection-preservation and capability-expiry checks. Typecheck, lint, catalog
wire snapshots, no-comments, brand links and verification-map checks passed.
The map also restores the existing recovery recipe's missing index link.

## Limits

This first advisor reports evidence and abstains from switching recommendations:
it always preserves the current selection because no controlled, task-verified
comparison dataset is connected. Provider success never becomes verified task
completion. These observations can inform a bounded comparison; they cannot
establish one model's causal advantage over another. No automatic policy learning,
benchmark promotion, Clef selection call or live quality claim is implemented.

Historical cost is recorded usage, not a subscription invoice. Base API rates do
not cover every cache-write, long-context, regional or processing-tier adjustment.
Execution duration excludes queue time, earlier failed attempts and later rescue.
Task matching is word overlap against each thread's current canonical title,
looked up per query only for rows already limited to the asking dog and the
current-thread or own-dog scope; nothing is stored or returned from that lookup.
A current title is not the task that thread ran at the time and is not a
historical task-quality label, and legacy rows without evidence never match.
It is not a semantic quality judgment. Native engine versions and verified outcome receipts are not yet joined.

The fixture proves the tool contract and evidence collection, not provider quality
or cross-model savings. Production rollout and functional observations are recorded
separately in [the release record](consolidation-release-2026-11-08.md). Existing
engine sessions need a fresh tool catalog to advertise the new tool.

## Real-provider tool observation, 2026-11-09

The isolated staged Kimi provider called `agents_execution_advice` once and settled
with its selection unchanged. Its recorded tool status was successful and its
retained preview showed `keep_current`; the preview was shortened and is not a
complete response capture. [The observation](execution-advisor-provider-2026-11-09.json)
qualifies discovery and invocation, separate from the full fake-engine contract
fixture and the production functional watch. Ineligible catalog rows remain
verbose; no LLM token or model-bill reduction is claimed.
