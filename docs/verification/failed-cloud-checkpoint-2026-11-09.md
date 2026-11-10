# Source checkpoints from failed cloud implementations

Branch: `clover/failed-cloud-checkpoint-20261109`.
Base: `49c1f18bb744848f66f2a4dc11c7fcd19413462f`.

## Failure and repair

A cloud implementation could write source, then exit nonzero during Claude execution.
The supervisor retained the failure and computer but never called collection, leaving
no `patchArtifact` for the existing explicit publication path.

The optional `ExecutionAdapter.collectPartial` capability is implemented only by
`LaterdogCloudAdapter`. Its normal and partial paths share `collectPatch`,
`COLLECT_COMMAND`, the files API and the existing 16,000,000-byte cap. The partial
path requires a running retained computer and a recorded nonzero `claude`-stage
exit. It never wakes or deletes that computer. Normal successful collection keeps
its existing wake/collection/deletion behavior.

The supervisor records the original provider failure first. Only failed
`laterdog-cloud` implementation/repair tasks without existing patch/head/review/
verification evidence can attempt partial collection. A durable
`failed_checkpoint_started` event keyed by job and task identity prevents another
attempt, including after restart and after more than 200 newer events. No new
provider submission, account decision, cache, service or artifact format is added.

A nonempty source diff uses the existing `patchArtifact` and `changes` fields, with
`failed_checkpoint_collected` explicitly calling it unverified failed work. State
remains `needs_attention`; original blocker and failure timestamp remain. Empty or
unsupported collection emits `failed_checkpoint_unavailable` without a patch.
Collection failures expose a fixed bounded diagnostic, keeping raw remote errors
out of job events. Configured credential values in a partial patch cause rejection;
the computer keeps its source for inspection. Artifact text is never executed.

Cancellation, replacement task/state and newer evidence are rechecked after awaits.
The retained patch is written exclusively, so an existing artifact file is not
overwritten. Review, cancellation, uncertain submission and other backends do not
use partial collection. Publishing still needs the existing explicit operation and
repository authority; this change never publishes, retries or verifies a failed job.

## Isolated evidence

Commands run on Clover's own cloud computer, under
`/home/dog/failed-cloud-checkpoint-20261109`, using Node 24.22.0 and pnpm 10.33.0.
No physical Mac, owner data, customer operations or real provider tasks were used.

- New supervisor regressions on unchanged source: 10 failed, 35 passed, including
  missing source retention and newer-state protection. `/tmp/clover-failed-before.log`.
- Updated supervisor and real-process adapter fixtures against unchanged source:
  24 failed, 7 passed, 54 skipped. This includes missing optional-capability failures;
  the end-to-end nonzero Claude-stage fixture specifically failed because no patch
  artifact existed. `/tmp/clover-failed-real-before.log`.
- The real-process fixture uses a disposable Git repository and fake computers API,
  runs the actual task script and canonical collector, writes the fixture-local source file `a.ts`, then exits
  Claude with code 3. It checks the retained patch/source, truthful failure, one
  launch, no publication, no wake and no deletion.
- Fixtures also cover empty diffs, configured-secret rejection, collection errors,
  unavailable/asleep/missing computers, non-Claude and missing exit status,
  cancellation/newer-state races, repeated ticks and restart deduplication. Existing
  successful collection, empty-success cleanup and trace-before-delete tests remain.

Final checks:

- `corepack pnpm exec vitest run server/laterdog/supervisor.test.ts
  server/laterdog/laterdog-cloud.test.ts server/laterdog/codex-cloud.test.ts
  server/laterdog/github.test.ts server/laterdog/http.test.ts
  server/laterdog/job-trace-http.test.ts scripts/no-comments.test.ts
  scripts/brand-links.test.ts`: 8 files, 132 tests passed.
  `/tmp/clover-failed-focused.log`.
- Added canonical byte-cap regression: 1 passed, 38 other adapter tests intentionally
  skipped by the test-name filter. `/tmp/clover-failed-cap.log`.
- `corepack pnpm exec tsc --noEmit -p tsconfig.server.json`: exit 0.
  `/tmp/clover-failed-types.log`.
- Targeted `corepack pnpm exec oxlint --deny-warnings` on the five changed TypeScript
  files: zero errors and warnings. `/tmp/clover-failed-lint.log`.

No full server suite, canonical build, native provider qualification or deployment
is claimed. Independent review and release remain with Root.

## Publication review repair

Independent review of `96339f4994fb8c6b09618a1723627173a0dad7ca` found that
explicit publication used the ordinary ready transition and cleared the provider
blocker. Failed provenance now derives from the existing durable checkpoint and
provider-failure events, without a duplicate job flag. The provider-failure event
also retains its original cause for recovery after verification and head changes.

Explicit checkpoint publication keeps `needs_attention` and the original failure
until actual current-head verification passes. The publisher plainly labels new
and existing PR bodies as unverified source checkpoints from failed tasks, without
copying the private failure text. Failed/blocked/unavailable verification preserves
the original failure; passed verification uses the existing ready transition.
A changed PR head invalidates evidence and restores the original failure gate.
Merge independently refuses failed checkpoints without passed verification for the
current recorded head, before invoking the publisher's existing current-head and
independent-review checks. Ordinary successful publication retains its behavior.

The canonical collector runs `git add -A`: partial collection stages the retained
computer's Git index and writes `task/patch.diff`. It preserves source files and the
computer but is not a read-only Git inspection. No artifact text is executed.

Before this review repair, six publication/provenance fixtures had five failures
and one pass against the published PR head. Afterward all six pass. Logs:
`/tmp/clover-failed-policy-before.log`, `/tmp/clover-failed-policy-after.log`.
Further fixtures cover explicit publication failure, new/existing PR labels and
successful progression after actual current-head verification and review. The
supervisor and publisher suites together passed 66 tests in
`/tmp/clover-failed-publication.log`.

Final repaired-head checks: all 142 tests in the same eight focused files passed;
server TypeScript passed; targeted lint on the four changed policy TypeScript files
had zero errors or warnings. Logs: `/tmp/clover-failed-repaired-focused.log`,
`/tmp/clover-failed-repaired-types.log`, `/tmp/clover-failed-repaired-lint.log`.
Independent Claude review on a separate cloud computer passed all 142 focused
tests and server TypeScript at repaired head
`6c924e245718f56c0cb8b3ea81300febc309c5fa`, including independent long-event-history,
restart, publication and merge-boundary probes. The original review's apparent
merge acceptance used a mock publisher: the real GitHub publisher already required
current-head verification and review. No real unverified GitHub merge bypass was
demonstrated. The repair adds the supervisor boundary and preserves failed
provenance through explicit publication.

## Native production qualification, November 10

PR147 merged as `0609ec0baf19b3b66325370461bcb21cad73079d`. The canonical
`pnpm laterdog:build` exited zero. Five compiled bundles replace `/app/laterdog`
as an opaque uid/gid-zero Linux layer, directories 0755 and files 0644, over the
previous production base. This is not a full Dockerfile rebuild. Immutable image:
`registry.cloudflare.com/da1336ec3e3f7d9a4971022ae074c5d7/laterdog-supervisor-scope@sha256:9de367a3850507087525cddf6b65da11b1019c6c78089baa0dbfff8a290e2a17`.

Dedicated staging Worker `a973228d-869c-4366-9991-96596f4e185e` restored four
synthetic-only jobs and refused a failed-checkpoint merge with HTTP409 before
publisher invocation, despite 250 later events. Wrong authentication and invalid
glob syntax were refused; a graceful native restart retained all four IDs and the
merge refusal. The isolated fixture had no owner data, real provider task or
computer binding. `providerQualified` and `realFailedProviderCollectionQualified`
remain false.

A fresh R2 backup passed SQLite quick_check and retained 81 jobs and two profiles.
Full `wrangler deploy` activated production Worker
`f7be1fac-6757-4cc4-9704-f23ef61a74a0`; the native application reported version22
with the matching digest. All ten bindings, including five secret names and both
plain-text values, were preserved. A completed read-only window ran 21 consecutive
qualified samples from 00:21:57.799 to 00:32:18.411 UTC. Every sample retained all
81 jobs, two profiles, 80 dogs and their tasks; the home stayed PID24, the WoW dogs
idle and the saved Clover/Patch selections Codex / Sol / Medium. Saved selections
do not prove the executing provider. All 21 samples reported low storage, with
free space approximately 0.75–1.33GB, so larger-fleet capacity remains unqualified.

Receipts are under `.laterdog-evidence/scope-release/`, including canonical build,
layer provenance, `checkpoint-native-qualification.json`, fresh backup, full
deployment and `checkpoint-production-native-monitor-private.json`. No production
failure was induced to test collection. Real provider partial-failure collection
remains unqualified; no new provider task, account retry or successful outcome was
invented. The default-off computer-workspace prototype is separate.
