# Supervisor rollout and dog resume, November 9

Operational receipts supplied by the root session for this job. They are attributed
facts, not checks run in this checkout. Credentials and private paths are redacted.

## Source

- Compiled supervisor files come from `a4256c8a` (one server bundler,
  `scripts/bundle-server.mjs`). Later commits `434a13ec` and `df5df16c` correct the
  test lifecycle (retained evidence, owned-child interruption cleanup) and remove an
  alias-only assertion.
- Root compiled smoke passed 19 checks at `434a13ec`. A separate cloud public
  `pnpm laterdog:build` and behavioral smoke passed.
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

- Actual-work monitor, 21 samples 11:32:40–11:42:58 UTC: functional criteria passed;
  9 low-space flags and minimum 1731444736 bytes free keep capacity unqualified.
- Post-supervisor ten-minute monitor started 12:14:29 UTC and was **in progress** at
  report creation. It has not been shown to pass; no later samples are recorded here.
- Not qualified: a full Dockerfile image rebuild, fleet capacity, a live provider
  beyond the receipts above, and production admin restart.
