# Cold archive foundation, 2026-11-08

This branch continues the preserved Kennel prototype in its own worktree. The prototype and all other worktrees remain intact. No archive job is enabled against live home data by this change.

## Implemented

- Archive objects live under the home's own archive prefix, separate from snapshot blobs. Normal snapshot garbage collection does not list or delete them. Archive DELETE requests are refused.
- Archive PUT bodies are bounded to 12 MiB while reading. Runtime files are copied in 8 MiB chunks. Each remote chunk is read back and hashed; the index is persisted and read back before a matching unchanged local file can be removed.
- Changed or replaced local files, failed uploads, corrupt readbacks, missing index entries and unsafe paths retain the local copy. Parent symlinks and credential directories are refused.
- Restores verify hashes and size before linking a staged copy into place. An existing newer file is never overwritten. Restored files can be restored again if later absent, and earlier versions remain in index history when a path is reused.
- Archived versions and blobs have no automatic garbage-collection path in this foundation. The prototype's destructive collection logic was not retained.
- The authenticated loopback bridge is implemented and tested but not started by the production runtime yet. No new credential was created or requested.

## Verification

On Jacob's Mac, Node 24.22.1:

- /tmp/clover-archive-home-suite.log: all 227 home tests pass, 25 files, including archive, state isolation and existing sync behavior.
- /tmp/clover-archive-worker-types-final.log: Worker TypeScript passes with the locked home dependencies.
- /tmp/clover-archive-no-comments.log: 10 no-comments tests pass.
- Targeted oxlint: zero warnings or errors; git diff --check clean.
- Fixtures cover restart and exact round-trip, two-chunk files, upload/readback/index failure, changing files, existing newer targets, corrupt restores, symlink ancestors, path rejection, version retention, bounded requests and authorization.

The first multi-chunk assertion used a generic deep buffer comparison and exhausted the test worker heap. It now uses byte equality directly; the unchanged large-file fixture passes. A missing standalone Worker dependency set was installed from its frozen lockfile in this Mac worktree; no installation or test ran on the shared home.

## Required before activation

1. Add an archive client using the existing secret-descriptor channel; never expose its runtime token to dog commands.
2. Restore a thread's exact saved logs/session data before starting or resuming its engine and before relevant history reads.
3. Serialize archiving with restoration and turn startup. Skip busy threads and any file still owned by an engine process; inactivity alone does not prove an open file is safe to remove.
4. Add byte/age caps and asynchronous scans for known thread/session files. Keep tool results, checkpoints and unmapped provider directories out until their restore consumers exist. The provider credential root is intentionally excluded.
5. Verify the actual scheduler/startup/restoration race in isolated fixtures. Deploy the Worker and runtime image through the normal container release, then verify archive restore and disk relief before claiming live completion.

Remote engines, workspace migration, reusable project environments and heavy-command guardrails remain separate unfinished stages. This foundation does not claim to solve the home's capacity problem.
