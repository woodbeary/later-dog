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
are rejected. Task text is not persisted by the advisor.

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
Task matching is word overlap against recorded task titles, not a semantic quality
judgment. Native engine versions and verified outcome receipts are not yet joined.

The fixture proves the tool contract and evidence collection, not provider quality,
production availability, cross-model savings or deployment. The feature requires a
server rollout and a fresh engine session to advertise the new tool.
