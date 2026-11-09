# Automatic log archive, 2026-11-08

Continues the verified archive foundation at 39bf6667f. Work is isolated in patch/automatic-log-archive; the foundation and earlier prototype worktrees remain intact.

## Behavior and boundaries

Only exact events/<thread>.ndjson and native/<thread>.ndjson files under the Cloud home's .laterdog directory are scheduled. Threads must belong to a known solo dog task, have no active engine session, no busy/setup claim, no pending request and no active coordination. Groups, provider sessions, credentials, tool results, checkpoints and workspaces are not scheduled.

Scans are asynchronous and nonoverlapping: every five minutes after a one-minute initial delay, at most 100 known threads and 64 MiB per pass, with a 24-hour file age threshold. Existing event deletion and idle-log trimming are bypassed while this bridge is configured. Existing active-write caps remain.

Each thread has a shared archive/restore/read gate. Startup first claims the busy slot synchronously, then waits for any archive and restores before engine dispatch. Failed restores keep requestPending and retry every five seconds independently of any client. The turn watchdog starts after restoration, so a storage outage is not treated as an engine stall. Stop cancels the pending dispatch. History and Activity reads restore before reading and hold the same gates.

The root runtime owns the archive store and authenticated loopback service. A fresh runtime-only token travels through the launcher's existing secret descriptor, is absent from server and engine environments, and is never logged. Before unlink, the root checks /proc descriptors by device/inode, fails closed on unknown ownership or exhausted scan budget, and rechecks the unchanged file stamp. The server also excludes every thread with an engine session. Destructive archive GC stays disabled. Earlier remote versions remain retained.

## Isolated evidence

- All 240 home tests pass in 29 files after integration, including the private ownership-probe cases: /tmp/patch-archive-home-ipc.log.
- Nine new service/coordinator fixtures cover archive/start contention, coordinator restart while the root archive is still running, root restart with a fresh index, restore outages with autonomous retry, Stop, history failure, exact log-only restoration, scan bounds, descriptor ownership and changes during ownership checks.
- A real isolated server fixture sends a request with no connected chat, blocks archive restoration, restarts the server, and observes pending-request pickup without a client. Only after storage recovers does the fake engine receive the original request, with the saved event bytes restored first. History reads then return the restored event. The run observed four archive blob reads across archive verification, failed restores and recovery.
- The real fixture log is recorded in /tmp/patch-archive-home-all.log. It uses temporary data, synthetic credentials and the repository fake engine. No live dog was resumed or replayed.
- Cloud secret boundary tests (42) and no-comments tests (10) pass: /tmp/patch-archive-boundary.log.
- Full lint passes with zero warnings/errors: /tmp/patch-archive-lint.log.

## Image compatibility and observability

A version-two bundled capability manifest binds log-archive support to the SHA-256 of both index.js and cloud-home-start.js. Image build and runtime startup also require this capability before starting an archive-backed home. The runtime refuses older pushed code without a matching manifest and keeps the image server, including when unpacking inherited a newer manifest from the base image. This prevents an older pushed server from bypassing restoration after the new runtime activates. A dedicated fixture covers missing, matching, inherited stale and corrupt manifests.

GET /api/storage reports whether the archive bridge is enabled, successful archive file/byte totals since server startup, last scan time and free bytes before/after its last completed scan. The initial live read-only baseline was 1,333,899,264 free bytes on a 19,228,708,864-byte volume; archive counters were absent, proving this code was not active then. No savings are attributed to this baseline.

Linux /proc ownership was also checked in an isolated linux/amd64 Node 24 container on the Mac: an actually held descriptor is refused and the same inode becomes eligible after close. Evidence: /tmp/patch-archive-linux-ownership.log.

All 20 account-continuation regression fixtures pass, including synthetic Grok capacity queues and legacy Kimi migration: /tmp/patch-archive-recovery-regression.log. This remains synthetic provider evidence.

## Container user boundary

The assembled-image smoke test exposed EACCES when root tried to stat the dog user's /proc file descriptors without CAP_SYS_PTRACE. It correctly retained all files, but could not make progress. The runtime now checks root-owned descriptors itself and asks a short-lived helper under the existing dog UID/GID to check that user's descriptors. The helper receives only device/inode metadata and a clean PATH-only environment; it receives no archive or state token. Unexpected UIDs, inaccessible descriptors and exhausted time/count budgets still keep the local file. No container capability was added.

The isolated Linux two-user process fixture proves the held dog file is refused, and becomes eligible after close while the dog process is still alive. It also proves the original root-only scan remains refused under that same boundary: /tmp/patch-archive-cross-uid.log.

Pending-request checks now use already-cached messages or a SQLite existence query instead of loading cold transcripts into the server cache. Cancelled requests do not block archiving, and unmigrated legacy files remain protected without importing them. All 20 message database tests pass: /tmp/patch-archive-pending-query.log. All 238 home tests pass again after this change: /tmp/patch-archive-home-uid.log.

The root launcher deliberately protects its descriptor table after switching service identities. It now answers metadata-only ownership probes over its private parent/child IPC channel. The root scan may leave that table to the launcher only after a matching private answer; a launcher change, held file, wrong reply, timeout or exit retains the log. Both server and launcher hashes are covered by capability version two. The same Linux process fixture also holds a log inside a protected root launcher, proves IPC refuses it, closes it and proves the combined root/dog/launcher check succeeds without exposing that private table: /tmp/patch-archive-protected-launcher.log.

## Build environment

The first amd64 build on this arm64 Mac crashed inside emulated esbuild with SIGSEGV. The JavaScript/frontend build stage now uses BUILDPLATFORM; the shipped runtime stays linux/amd64. Dockerfile contract checks pass (11 tests, three existing skips). The next attempt lost the Docker VM connection during the build; its original two-GiB build VM was restarted with four GiB. These are build-environment observations, not a demonstrated cause of the phone or live home failures.

The packaged descriptor helper must also be readable by the dog UID. The runtime Dockerfile now sets that one nonsecret module to 0644 and checks its syntax under the actual dog account. Other runtime secrets and descriptor tables remain private.

The assembled-image fixture runs with the image's normal tini entrypoint: docker run --rm --platform linux/amd64 -v "$PWD/deploy/laterdog/home:/fixture:ro" IMAGE node /fixture/image-archive-fixture.mjs. Overriding the entrypoint with Node bypasses the process reaper and leaves orphaned zombie CLI probes; the ownership guard correctly refuses those inaccessible descriptor tables. The fixture command was corrected instead of weakening the guard.

## Release status

The assembled linux/amd64 image passes the full production-entrypoint smoke: health, host refusal, pairing, owner session, archive bridge, automatic archive, history restoration and live updates. It archived two logs totaling 2,097,498 bytes, observed free space rise from 85,368,287,232 to 85,370,392,576 bytes (2,105,344 bytes), then restored both exact original byte strings through the history route. The isolated state service retained the archive index and two chunks. This is isolated disk evidence, not live savings. Log: /tmp/patch-archive-image-smoke7.log.

Full Wrangler deployment from Jacob's Mac completed from source main b36277b97 with the existing OAuth login, preserving all eight production variables. Worker version: 3b063918-d4b6-4bf6-a960-2a286c16a54b. Standard image digest: 4720a293b0295e4d725b4263bf34a40ce0fb8bb179d20f780ed932c2a350b81e. Large image digest: 2f1e9b9ead909d74aecd84275a53d66e5ab1668fb4cf82555b6908ce776a5d4b. Log: /tmp/patch-archive-deploy.log.

Activation was initially unconfirmed at this checkpoint. The 00:06:24 UTC read-only home check still returned old PID 775360 with no archive counters. The Large application still reported version 48 and its prior image, with an active rollout and a starting instance. The immediately-before-deploy live baseline was 1,328,283,648 free bytes; the subsequent old-runtime reading was 820,969,472. Neither value establishes archive relief. No stopped dog was woken or its messages replayed.

Clover independently confirmed activation at 2026-11-09 00:37 UTC: /app/cloud/build reports b36277b97 and the packaged home health check succeeds. A fresh filesystem reading shows 2,175,283,200 available bytes on the same 19,228,708,864-byte volume (89% used). That df reading alone is not attributed to archive savings; the authenticated counters below are. Clover reran the five archive/coordinator/launcher/capability/server fixture files on the Mac: all 24 tests pass, including a closed-chat pending request surviving restore failure and server restart, then dispatching only after restoration recovers.

Provider/session migration and workspace/engine scaling remain separate work. Log-only archive savings do not establish that the full home capacity problem is solved.

## Live archive counters

At 2026-11-09 00:38:18 UTC an authenticated read-only GET /api/storage used the desktop app's existing owner session from cloud-access.json through scripts/cloud-access.ts; no token was printed or logged. It returned HTTP 200 from the home Clover checked, and /api/health returned 200.

- archive.enabled: true
- archivedFiles: 36
- archivedBytes: 67,101,583
- lastScanAt: 2026-11-09 00:34:34 UTC
- freeBefore: 2,112,221,184; freeAfter: 2,174,836,736 (+62,615,552 bytes in that scan)
- disk at read time: 2,180,206,592 free of 19,228,708,864; janitor freed 0 bytes and stopped 0 processes at 00:35:34 UTC

The free-space gain is measured across one scan on a live volume, so concurrent writes are included; archivedBytes is the logical size of the removed logs since this server started. These 36 files are event or native logs for idle known solo threads only. Session, provider, tool-result and checkpoint archiving and destructive archive GC remain disabled. The rest of the rise from the 1,333,899,264-byte pre-release baseline is not attributed to archiving.
