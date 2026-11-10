# Archive untracked engine sessions (2026-11-10)

## Problem, measured read-only on the home

- 4.34 GB of Claude session files: 991 MB tracked by a task's `resumeCursors`, 3,344 MB not tracked by any task. 1,833 MB of the untracked bytes are 72 h or older.
- `LogArchiveCoordinator` only looked at tracked sessions, so untracked history stayed on disk forever.
- The per-sweep budget skipped any session larger than what was left, every sweep. Six untracked sessions are 179–414 MB, more than the 128 MiB budget.

## Choice

- **Chosen:** extend the existing coordinator, its discovery walker, its gate map and the root archive bridge. The bridge already streams 8 MiB chunks, reads every chunk back, checks the file's identity and open descriptors before unlinking, and runs archive and restore in one serial queue.
- **Rejected:**
  - A workspace ownership or storage manager (prototype 146): it duplicates ownership and depends on remote transport that isn't qualified.
  - Raw deletion: it loses history.
  - Lowering the age only: it never reaches untracked sessions.
  - A new global queue.

## What changed

- **Discovery:** `findSessionFiles` also accepts a predicate. A second pass finds untracked session groups with the same walker, the same name, protected-name, symlink and depth rules, and its own 50,000-entry limit. If that limit overflows, only the untracked groups are refused.
- **Ownership snapshot:** the server wires `outsideSessions` through `outsideSessionOwners(bots, isGroupThread)`, a read-only snapshot of the Store. It lists every Claude session that a non-thread owner references:
  - a group-thread task's cursors
  - a bot-level cursor, unless it matches that bot's own active task (`bot.threadId`), which is only a mirror, because turns resume from the task record

  A bot with no active task has all its cursors listed. Without `outsideSessions`, untracked groups are kept.
- **Session locks:** `session:<id>` keys in the same gate map.
  - `beforeTurn` holds the thread gate, then the thread's session locks in sorted order, restores, and re-reads the cursors. If they changed while it waited, it restores again.
  - Every session archive holds that session's lock. A sweep takes the thread gate first, then one session lock, and never the reverse.
- **Recheck under the lock, after the files are re-read and right before the budget is spent and the upload starts:**
  - Any session in a fresh `outsideSessions()` snapshot is kept, even if an idle thread also tracks it.
  - Otherwise, a session referenced by a thread is archived only if every such thread is idle.
  - An unreferenced session needs `outsideSessions`.
  - Every file must still be a regular file, not a symlink, and 72 h old.
- **Budget:** 128 MiB per sweep stays. At most one group larger than the budget is archived, and only as the first session work of a sweep, which uses up the budget. A group that didn't fit is remembered and goes first next sweep. Untracked groups are visited round-robin by id. A group over the bridge's 2,000-path limit is kept.
- **Unchanged:** the 72 h age, the bridge, its 120 s call timeout, restore by session id, and the thread-log path.
- **Existing test updated:** it asserted that a session larger than a 1-byte budget is kept. It is now archived as the sweep's one oversized group.

## Race barrier

- **The archive wins the lock:** the turn's `beforeTurn` waits for the session lock, then restores every file from R2 before it returns.
- **The turn wins the lock:** it restores and returns. Its thread is busy from the dispatch claim, so the recheck keeps the session.
- **The turn's cursor changes after discovery:** the recheck under the lock sees the busy thread and keeps the session.
- **A bridge call times out on the server's side while the root keeps going:** a later `restore-sessions` waits in the root's serial queue behind that archive.

## Ownership repair (after native review of 4b587ac)

- **Root's native review** (`task_e_6af28ee34d188329b28fb012fef92290`) found that `4b587ac` archived a session that an idle thread shares with a group thread or with an independent bot-level cursor. `sessionFree` returned true once any eligible thread tracked it.
- **The flat `referencedSessions` list was replaced** by the ownership snapshot above. It tells a normal mirror apart from an independent owner, so tracked sessions still archive.
- **The budget is now spent only after the final ownership check,** so a refused session no longer uses up the oversized slot.
- **Before**, `4b587ac` with its own flat-list wiring and the new tests: 2 failed, 15 passed.
  - The session shared with a group chat or another dog's cursor was archived.
  - Group ownership that appeared while the archive waited on the lock was ignored.
- **After:** 26 of 26 (session-archive 17, log-archive 9), three runs.
- **Other checks:** server and home `tsc` exit 0, oxlint is 0/0 on the 3 code files, and no-comments finds 0.

## Restore-cap repair (after Clover's review of 1def52c)

- **The finding:** `beforeTurn` restores at most 200 session IDs per thread. At `1def52c`, an ID past that cap was neither tracked nor outside, so it was archived as untracked, even while its thread was busy.
- **The fix:** ownership now uses a thread's full session list, and a session past its thread's restore cap is always kept. Archiving still uses the capped list.
- **Before**, at `1def52c` with the new test: that test failed.
- **After:** 27 of 27 (session-archive 18, log-archive 9), three runs.
- **Other checks:** server and home `tsc` exit 0, oxlint is 0/0, and no-comments finds 0.

## Tests

Home package tests `test/session-archive.test.ts` and `test/log-archive.test.ts`, run on Kennel's cloud computer with Node 24 and the home's vitest 3.2.7.

- **Before**, base `05b509d7` source with the new tests: 6 failed, 18 passed.
  - The untracked group was never archived.
  - Both paused-archive races timed out because no archive started.
  - The oversized group stayed skipped.
  - The existing 1-byte budget case now expects archiving.
- **After:** 24 of 24, three runs.
- **Other checks:** server `tsc -p tsconfig.server.json` exits 0, home `tsc --noEmit` exits 0, oxlint is 0/0 on the 3 changed files, and the no-comments check finds 0.

The new cases cover:
- A 72 h untracked group archived while young, protected, symlinked, busy-thread and group-only sessions are kept, and nothing is archived without `outsideSessions`.
- A session an idle thread shares with a group chat or with another dog's independent cursor is kept, group-only and other-dog-only sessions are kept, and a bot's mirror of its own active task is archived.
- Group ownership that appears while the archive waits for the session lock is seen by the recheck.
- A later resume of that id restores every file before the turn.
- During a restore outage the turn stays pending, and Stop returns false without writing an empty file.
- Both race orders, with a paused bridge.
- Two threads sharing two sessions in opposite cursor order, plus a sweep, with no deadlock.
- An 8-byte budget: one small group, then the oversized group alone in the next sweep, then the rest. Every sweep makes exactly one bridge call.

## Limits

- **No live run:** no live archive, no real R2 and no native image run. There is no throughput figure for a 414 MB group, and a 120 s bridge call may time out on large groups while the root finishes the archive.
- **Resumes outside `beforeTurn`:** a resume that doesn't go through `beforeTurn` (a manual CLI resume outside later.dog) isn't restored automatically. The bytes stay in R2 and can be restored by session id.
- **Cursor changes after `beforeTurn`:** a cursor change after `beforeTurn` returns and before the engine opens isn't covered by this change.
- **Not a guarantee:** this bounds history growth only as fast as sweeps run. It doesn't guarantee capacity.
