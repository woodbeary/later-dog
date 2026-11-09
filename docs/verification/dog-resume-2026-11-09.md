# Supervisor rollout and dog resume, November 9

Operational receipts supplied by the root session for this job. They are attributed
facts, not checks run in this checkout. Credentials and private paths are redacted.

## Source

- Compiled supervisor files come from `a4256c8a` (one server bundler,
  `scripts/bundle-server.mjs`). Later commits `434a13ec` and `df5df16c` correct the
  test lifecycle (retained evidence, owned-child interruption cleanup) and remove an
  alias-only assertion.
- Root compiled smoke at `434a13ec`: the retained receipt lists 18 successful
  entries. One is "build skipped by --skip-build", a status and not a test success. The
  rest are 17 behavior assertions; the canonical bundle was built separately. This is
  not 19 checks.
- A separate cloud public `pnpm laterdog:build` and full smoke passed.
- The old duplicate builder, as a counterfactual, failed with
  `Dynamic require of "events"` before any HTTP.

## Image

This was not a full Dockerfile rebuild. Docker was unavailable and was not restarted.
Only the five compiled `dist-server/laterdog` JS files from `a4256c8a` were appended to
the exact prior image `4be22d861908a1ac6be4280f86f8f311c1f6d6f02682d8577e9c2c5b691635d5`
as one opaque folder-replacement layer.

- Preserved byte for byte: Node 24.21 base, native CLIs, `docker-entrypoint.sh`, app
  entrypoint. Runtime config equality passed.
- The current entrypoint's executable content equals the base; only comments differ.
- Pinned in `deploy/laterdog/cloudflare/wrangler.jsonc` as
  `registry.cloudflare.com/…/laterdog-supervisor-options@sha256:4e3fff20…5d42e`;
  `image_build_context` is removed. Bindings, vars, cron and `standard-3`/max 1 are unchanged.

## Isolated candidate

Separate Cloudflare Worker `3d980f01`, new R2 bucket, synthetic credentials, no
COMPUTERS service, no owner data, candidate `application/instance` v1: wrong token 401;
authenticated startup 200; stored repository; graceful restart 202, then a transient
cold-start 500, then restored 200; no jobs or providers.

## Production switch

- Read-only backups first: DB, config, artifacts, encrypted Codex and encrypted GitHub
  state. Fresh DB `quick_check` ok; all 67 expected job IDs present.
- Full production `wrangler deploy` (no API patch) activated Worker
  `d3debf95-2ef7-4b1c-bc4e-83ddf100a6d8`. Supervisor app `a0343d3d-…`, running instance
  `1160ae77…` version 20 on the candidate image confirmed. The deploy replaced the
  instance automatically.
- A later readiness/admin sequence stopped on a cold-start 500 before sending admin
  restart. **A production admin restart was not performed and is not claimed.**
- Readiness recovered at 12:13:19Z: workspace 200, all 67 jobs and 2 profiles retained,
  active 0. Codex CLI 0.154.0, later.dog Cloud and GitHub (as woodbeary) authenticated.
- Preserved: original COMPUTERS binding, STATE bucket/namespace, 5 secrets, resource
  sizes. Added: canonical trace retention 30.

## Dog resume

At the owner's request saved dogs resumed except the WoW dogs.

- Nine primary continuations accepted: Task.com staging, nextdoor, resize tool, Kennel,
  taskr apidoc, reflow pm, reflow ai, ocjr codex pm, ocjr ops.
- Clover audited the roster and resumed the read-only x bot. Root reconciled hidden
  Biscuit, Churro, Cocoa and Rocket without unhiding them or replaying obsolete work.
  All 80 IDs retained.
- Walker, Walker Bench, Walker Routing and Walker Stalls stay idle; the game is untouched.
- Nextdoor: token accepted across reachable Macs including Air, send/dispatch off;
  missing account details remain a genuine blocker.
- Reflow plan sign-in, deployment sign-in and x bot sign-in remain user-only where
  secure cards exist.
- Taskr API documentation completed; current Task staging tests resumed. No synthetic
  pings to real dogs.
- Patch owns a separate desktop packaged MCP smoke failure; not fixed here. Phone beta
  `e92d9bc`/`f66c11dd` was published by Patch; physical device uptake is unobserved.
- No new native screen-control claim; Dev was never restarted.

## Monitoring and limits

These are descriptive observations, not throughput or latency benchmarks.

- Initial pre-rollout actual-work monitor: 21 samples, 11:32:40.292–11:42:58.618 UTC,
  all passed; 9 low-space flags.
- Final post-rollout monitor is **complete**: 21 consecutive qualified functional
  samples, 12:14:29.515–12:24:54.613 UTC. All 80 dog identities, all 67 pre-switch jobs
  and both profiles retained; all four WoW dogs idle; home PID 5161 throughout; Clover
  and Patch both selected Codex / gpt-6.1-sol / medium on every sample.
- All 21 samples were low-space flagged. Minimum free space 1531617280 bytes; minimum
  available memory 4773191680 bytes. Larger-fleet capacity remains unqualified.

## Root observations of quiet testers

- Task testers were checked while quiet: the coordinator reconciled actual recent traces
  at 12:22; Maria's screenshot at 12:21:53 and planned waiting; Linda 12:18:16; Devon
  12:19:05, waiting between checks; Kevin an explicit 15 minute wait. Root re-read
  Maria's newer 12:22 screenshot independently; no restart or duplicated booking.
- Four original staging testers continue round 13. An actual staging defect in past
  helper jobs is assigned to Task after reports; it is not declared fixed.
- Kennel reconciled helpers: archive and saved-environments still running; engine
  hardening committed `f5ae422e5` awaiting tests. No duplicate cloud job was submitted.
- After the supervisor switch the documentation repair job `78ddc5c8` completed and its
  independent review `8cc032b8` completed. The later.dog Cloud provider transport
  worked; this does not qualify all models or capacity.
- Patch reports the packaged desktop MCP smoke and 30 Mac helper tests passed on
  `075609e1a`; app signing and notarization were still ongoing at last read. There is no
  desktop release claim. Phone physical uptake is unobserved.
- Sign-in and missing-account blockers stay in the report.

## Failed or incomplete checks

- The automatic supervisor verification action returned 409 "spawn docker ENOENT": the
  Docker wrapper is unavailable in the supervisor. Automated verification is not green.
- The configured command `node scripts/smoke-native-work.ts` was then run directly in
  the root isolated worktree at `924b8925` and returned ok with 7 checks: duplicate
  event, child isolation, late completion, disk reopen, interrupted recovery, retained
  result, thread boundary. `providerQualified` was false; a fixture makes no native or
  provider claim.
- Root local comments and brand guards at `434a13ec` timed out on 2 tests on a busy Mac;
  11 passed. No source bug is inferred from the timeout. Cloud writer and reviewer runs
  at final `924b8925` each passed all 13 guards.

## Cleanup

The isolated QA Worker, container and new R2 bucket were all deleted after receipts were
retained, confirmed at 12:23 UTC. There was no owner app restart.

## Not qualified

A full Dockerfile image rebuild, fleet capacity, a live provider beyond the receipts
above, production admin restart, and automated verification via the supervisor.
