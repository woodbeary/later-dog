# Engine session archive, 2026-11-09

Continues the live automatic log archive ([log archive evidence](log-archive-2026-11-08.md)). Branch `kennel/session-archive`, based on main `16d20b46b`. Not merged, not released.

## Why

Measured on the shared Cloud home on 2026-11-09 (20 GB volume, 89% used): Claude session `.jsonl` files older than three days took about 0.96 GB (185 files) under `.laterdog/providers` and about 0.97 GB (244 files) under `.claude/projects`. The log archive did not touch them.

## Behavior and boundaries

- A thread's Claude sessions are the UUID values in its task's `resumeCursors` (a string, or a legacy `{ sessionId }`). Other cursor values are ignored.
- The only session paths scheduled are `<config>/projects/<slug>/<session>.jsonl` and the files in `<config>/projects/<slug>/<session>/`, up to two folders deep, where `<config>` is `.claude` or `.laterdog/providers/<instance>`. Credentials, `.claude.json`, `file-history`, other account files and sessions no cursor names are never scheduled.
- A thread qualifies under the same idle check as its logs: known solo task, no engine session, not busy or claimed, no pending request, no active coordination. A session also named by a busy thread is held.
- A session is archived as a unit only when every one of its files is at least 72 hours old. A symlink, a protected name (`auth`, `credentials`, `secrets`, `token`), a folder deeper than allowed or an exhausted scan budget (50,000 directory entries) keeps the whole session local. Sessions get their own 128 MiB budget per pass, separate from the 64 MiB log budget.
- Startup restores the thread's logs, then its sessions, inside the existing per-thread gate and before engine dispatch. That puts restoration ahead of both the local Claude spawn with `--resume` and the remote-engine plan that inventories the session roots it pushes. A failed restore keeps the turn pending and retries every five seconds. Stop still cancels. History reads restore logs only.
- The root archive keeps the hash read-back before unlink, the stamp recheck and the `/proc` ownership checks. Its generic allowlist no longer accepts any path under `.claude/projects/`, only the exact session shape. Existing index entries of the older broad shape still parse, so a saved index cannot become unreadable. `/restore-sessions` takes at most 200 exact session ids and restores only index entries of the session shape for those ids. `/restore-logs` still refuses anything but exact thread logs.
- Capability version 3 replaces version 2 in both the bundle manifest (`scripts/bundle-server.mjs` now imports `ARCHIVE_CAPABILITY`) and the runtime check. A pushed server built for version 2 is refused and the image server is kept, as before.
- `GET /api/storage` `archive` now carries `sessionFiles` and `sessionBytes` beside `archivedFiles` and `archivedBytes`, which stay log-only. The root `/status` reports a `sessions` count and size for what is currently archived, plus `sessionFiles`/`sessionBytes` since the runtime started.

## Isolated evidence

All runs used Node 24.22.1 on Jacob's Mac in the worktree, against temporary folders, synthetic sessions and the repository fake engine. No live home, dog or data was touched. The Mac's load average was 25 to 43 from other work during these runs.

`run_on_computer` only accepts folders on the shared Cloud home, and this worktree is on the Mac, so the suites ran on the Mac with `shared_computer`. Nothing ran on the shared home.

| Command (from the worktree) | Result |
| --- | --- |
| `cd deploy/laterdog/home && pnpm exec vitest run` | 31 files, 253 passed, 0 failed |
| `cd deploy/laterdog/home && pnpm exec vitest run test/session-archive.test.ts test/log-archive.test.ts test/archive-capability.test.ts test/archive.test.ts` | 4 files, 30 passed, 0 failed |
| `pnpm exec vitest run server/drivers/claude.test.ts server/drivers/claude-remote-engine.test.ts server/drivers/claude-compaction.test.ts server/drivers/claude-tasks.test.ts server/laterdog/engine-placement.test.ts server/testing/fakes-self-contained.test.ts` | 6 files, 261 passed, 1 skipped (already skipped on main), 0 failed |
| `pnpm exec tsc -p tsconfig.server.json --noEmit` | exit 0 |
| `pnpm exec oxlint --deny-warnings` on the 10 changed code files | 0 warnings, 0 errors |
| `pnpm exec vitest run scripts/no-comments.test.ts` | 10 passed |
| `pnpm build:server`, then `archiveCompatible("dist-server/cloud-home-start.js")` | exit 0, manifest `logArchive: 3`, compatible `true` (after rebasing onto main `075609e1a`) |
| `pnpm exec vitest run scripts/brand-links.test.ts --testTimeout 180000` | 3 passed (the default 20 s timeout expired once under load) |

Logs are in `/tmp/ksa-evidence/` on the Mac.

New coverage in `deploy/laterdog/home/test/session-archive.test.ts` (9 tests):

- cursor parsing keeps only exact session ids
- idle known threads' transcripts, session-folder files and provider-instance sessions are archived after 72 hours. Credentials, `.claude.json` in both config roots, file history, an unknown thread's session and a session shared with a busy thread stay
- session and log counters are reported separately
- recent files, busy threads, protected names, symlinks inside the session folder, too-deep folders and the byte budget each keep the session
- symlinked transcripts, project folders and provider folders are never followed
- the root allowlist refuses credentials, traversal, restoring-prefix names, wrong extensions, uppercase ids and file history. `/restore-sessions` refuses non-ids with 400 and missing auth with 401, and `/restore-logs` refuses session paths
- archived bytes come back exactly before `beforeTurn` resolves, and a newer local copy is never overwritten
- restore outages keep the turn pending (three failed reads, then success on the fourth) and a stopped turn returns false
- remote placement: `planClaudeRemote` + `engineInventory` see no session files while archived, then exactly the restored transcript and subagent file with matching hashes after `beforeTurn`

Real server fixture in `deploy/laterdog/home/test/log-archive-server.test.ts`: the fake engine records the session file it can see at launch (`FAKE_CLAUDE_SESSION_PROBE`). After a first turn creates session `1bd87bb1-…`, the server stops. The session file is written with mtime 0 and archived by the root archiver, and the server restarts behind an unavailable archive store. The second message stays undispatched while restore is retried (no engine launch, prompt absent). Once the store recovers, the engine launches with `--resume` for the same session and sees a SHA-256 equal to the archived bytes. The run took four archive reads. The existing closed-chat log fixture still passes.

Mutation check: with session restoration removed from `beforeTurn`, the three restore tests (exact bytes, outage retry, remote placement) fail.

`archive-capability.test.ts` now also proves that a version-2 manifest with matching hashes is refused.

## Not done

- Not merged, built into an image or deployed. Live savings are unmeasured.
- Sessions that no resume cursor names (after a context reset, rewind or deleted task) are not scheduled. Part of the measured 1.9 GB may be in that state. Removing them would need a separate, deliberate retention rule.
- Codex, Grok and other engines' session stores are not included.
- Destructive archive GC stays disabled. Archived versions are kept.

## Release needs

1. Merge to main after review.
2. Rebuild both home images. The runtime (`archive.mjs`, `archive-capability.mjs`) and the bundled server/manifest must ship together. The Dockerfile capability check rejects a mismatch.
3. Run a full `wrangler deploy` of the home Worker, preserving production variables, with no changes to `wrangler.production.json`, bindings or image pins beyond the normal image build.
4. After activation, read `GET /api/storage` and check that `archive.sessionFiles`/`sessionBytes` rise after scans more than five minutes apart, and that a resumed old thread still answers in context.
