# Automatic log archive, 2026-11-08

Continues the verified archive foundation at 39bf6667f. Work is isolated in patch/automatic-log-archive; the foundation and earlier prototype worktrees remain intact.

## Behavior and boundaries

Only exact events/<thread>.ndjson and native/<thread>.ndjson files under the Cloud home's .laterdog directory are scheduled. Threads must belong to a known solo dog task, have no active engine session, no busy/setup claim, no pending request and no active coordination. Groups, provider sessions, credentials, tool results, checkpoints and workspaces are not scheduled.

Scans are asynchronous and nonoverlapping: every five minutes after a one-minute initial delay, at most 100 known threads and 64 MiB per pass, with a 24-hour file age threshold. Existing event deletion and idle-log trimming are bypassed while this bridge is configured. Existing active-write caps remain.

Each thread has a shared archive/restore/read gate. Startup first claims the busy slot synchronously, then waits for any archive and restores before engine dispatch. Failed restores keep requestPending and retry every five seconds independently of any client. The turn watchdog starts after restoration, so a storage outage is not treated as an engine stall. Stop cancels the pending dispatch. History and Activity reads restore before reading and hold the same gates.

The root runtime owns the archive store and authenticated loopback service. A fresh runtime-only token travels through the launcher's existing secret descriptor, is absent from server and engine environments, and is never logged. Before unlink, the root checks /proc descriptors by device/inode, fails closed on unknown ownership or exhausted scan budget, and rechecks the unchanged file stamp. The server also excludes every thread with an engine session. Destructive archive GC stays disabled. Earlier remote versions remain retained.

## Isolated evidence

- All 238 home tests pass in 28 files after integration with main and the compatibility/counter checks: /tmp/patch-archive-home-final.log.
- Nine new service/coordinator fixtures cover archive/start contention, coordinator restart while the root archive is still running, root restart with a fresh index, restore outages with autonomous retry, Stop, history failure, exact log-only restoration, scan bounds, descriptor ownership and changes during ownership checks.
- A real isolated server fixture sends a request with no connected chat, blocks archive restoration, restarts the server, and observes pending-request pickup without a client. Only after storage recovers does the fake engine receive the original request, with the saved event bytes restored first. History reads then return the restored event. The run observed four archive blob reads across archive verification, failed restores and recovery.
- The real fixture log is recorded in /tmp/patch-archive-home-all.log. It uses temporary data, synthetic credentials and the repository fake engine. No live dog was resumed or replayed.
- Cloud secret boundary tests (42) and no-comments tests (10) pass: /tmp/patch-archive-boundary.log.
- Full lint passes with zero warnings/errors: /tmp/patch-archive-lint.log.

## Image compatibility and observability

A bundled capability manifest binds log-archive support to the SHA-256 of index.js. The runtime refuses older pushed code without a matching manifest and keeps the image server, including when unpacking inherited a newer manifest from the base image. This prevents an older pushed server from bypassing restoration after the new runtime activates. A dedicated fixture covers missing, matching, inherited stale and corrupt manifests.

GET /api/storage reports whether the archive bridge is enabled, successful archive file/byte totals since server startup, last scan time and free bytes before/after its last completed scan. The initial live read-only baseline was 1,333,899,264 free bytes on a 19,228,708,864-byte volume; archive counters were absent, proving this code was not active then. No savings are attributed to this baseline.

Linux /proc ownership was also checked in an isolated linux/amd64 Node 24 container on the Mac: an actually held descriptor is refused and the same inode becomes eligible after close. Evidence: /tmp/patch-archive-linux-ownership.log.

All 20 account-continuation regression fixtures pass, including synthetic Grok capacity queues and legacy Kimi migration: /tmp/patch-archive-recovery-regression.log. This remains synthetic provider evidence.

## Release status

Not yet deployed at this documentation checkpoint. No live disk relief is claimed. Actual Worker/runtime image deployment, isolated image checks, release identity and live read-only counts/disk measurements are recorded when those gates complete.

Provider/session migration and workspace/engine scaling remain separate work. Log-only archive savings do not establish that the full home capacity problem is solved.
