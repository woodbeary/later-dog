# Remote Claude account handoff

Status: draft for review; not merged, deployed or verified with a live provider.

## Cause and ownership choice

Each account adapter has its own sessions map. An account switch could launch without finding the previous account's idle engine, so the remote relay correctly refused it as busy. Within one adapter, spawn-contract changes also closed stdin without awaiting shutdown.

An adapter release method would require the dispatcher to coordinate former adapters. This fix instead extends the existing warm-engine lifecycle owner: one exact engine per data-directory/Claude/thread key, with adapter identity and idle/drain callbacks. Account maps retain protocol state; the warm owner authorizes replacement. No new supervisor or remote registry is introduced.

## Behavior

Matching same-account warm sessions reuse their process. Account changes retire only the same thread's idle owner. Model, context and placement changes await that same retirement path. Active turns and known running helpers refuse retirement. The drain callback rechecks session identity and idle state before stopping anything.

Replacement requires process-tree stop confirmation and session closure. A lost remote connection does not confirm native exit. An uncertain owner stays held after protocol closure; a later positively confirmed stop may release it. Unconfirmed retirement cannot admit replacement. Remote relay locks are unchanged.

Launch reservations check cancellation/newer-message precedence after asynchronous preparation and draining, and immediately before spawn. Stop, stopAll and disposal cancel pending starts. Old cleanup cannot release newer ownership. Interrupted retry preparation ends as interrupted.

The existing stopper gets a 2-second grace: placed-engine transport bounds total at most 16 seconds, followed by a separate 5-second session-close bound. Failed confirmation rejects replacement.

## Verification

Node 24.22.0, pnpm 10.33.0, on Patch's existing cloud computer. Only disposable homes, fake engines, synthetic accounts and local relay transport; no owner data or live dog QA.

The two-account regression fails on base `49c1f18bb744848f66f2a4dc11c7fcd19413462f` with the actual busy refusal. With the fix, both accounts answer, matching followups reuse the engine, and each new relay launch sees the previous lock absent. The unrelated thread's lock stays unchanged. A synthetic known-helper state refuses handoff without changing the current lock.

Warm-owner tests cover active work and newer starts, exact-owner release, confirmed stop ordering, uncertain stop refusal, and Stop/newer-start races. The transport fixture proves that a dropped relay connection does not confirm shutdown. Existing driver tests cover retry cancellation, delayed Stop, reset/model/placement changes, and later confirmed cleanup of an uncertain stop.

Final frozen-source validation: **293 passed, 1 existing skip across 8 files**. Full typecheck, full lint (zero warnings/errors), and locale validation passed. Raw receipts remain in `.laterdog-evidence/remote-account-handoff/` in the preserved cloud review checkout.

## Limits

Source and isolated transport qualification only. Real provider limits, native account continuation, deployment and job 29's workspace prototype remain unqualified here. Root owns review and activation. The slow-computer-wake issue remains separate.

## Exact final commands

```sh
pnpm exec vitest run server/drivers/claude.test.ts server/drivers/claude-remote-engine.test.ts server/drivers/claude-tasks.test.ts server/laterdog/warm-engines.test.ts server/laterdog/engine-remote.e2e.test.ts server/laterdog/engine-placement.test.ts server/claude-warm-session.e2e.test.ts scripts/no-comments.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
```

The unchanged-base run uses the identical final handoff regression with `-t "drains the old account"`; it fails with the relay busy refusal.

| Private log | Exit | SHA-256 |
| --- | --- | --- |
| before-exact.log | 1 | `059354f10cf36de65466a920abb14a751bee6645debc753ef8668f05490e3027` |
| focused-final.log | 0 | `7c777587bc15ab6758995c015240c5cd3c48f8e7a977c84193cc716b9b16ffb7` |
| types-exact.log | 0 | `0cfa4ea96a1fa0ec86d2d149087d765bc256ae510ff67ccd1fb66c07fb4cc3cb` |
| lint-exact.log | 0 | `ba2c43285fcb94761314660b8cd0647f6d13e0cc5e6b36cfb2a12221ffcf18c8` |
| i18n-exact.log | 0 | `0d6c65d8020c818f7f2132e49924fb5a0d568112b5a80ce9e15689cd26bc7047` |

The full pre-push checks ran on the cloud computer. The publication hook is skipped on the shared home solely to avoid repeating heavy checks there. No merge or deployment is included.
