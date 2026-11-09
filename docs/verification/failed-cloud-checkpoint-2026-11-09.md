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
  runs the actual task script and canonical collector, writes `src/a.ts`, then exits
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
