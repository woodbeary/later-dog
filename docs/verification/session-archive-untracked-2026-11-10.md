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
- **Who may archive an untracked group:** only when `referencedSessions` is wired. The server passes every Claude session id in any bot's or task's `resumeCursors`, including group threads. Without it, untracked groups are kept.
- **Session locks:** `session:<id>` keys in the same gate map.
  - `beforeTurn` holds the thread gate, then the thread's session locks in sorted order, restores, and re-reads the cursors. If they changed while it waited, it restores again.
  - Every session archive holds that session's lock. A sweep takes the thread gate first, then one session lock, and never the reverse.
- **Recheck under the lock, right before upload:**
  - A session referenced by a thread is archived only if every such thread is idle.
  - A session referenced only outside threads (group chats, bot-level cursors) is kept.
  - An unreferenced session needs `referencedSessions`.
  - Every file must still be a regular file, not a symlink, and 72 h old.
- **Budget:** 128 MiB per sweep stays. At most one group larger than the budget is archived, and only as the first session work of a sweep, which uses up the budget. A group that didn't fit is remembered and goes first next sweep. Untracked groups are visited round-robin by id. A group over the bridge's 2,000-path limit is kept.
- **Unchanged:** the 72 h age, the bridge, its 120 s call timeout, restore by session id, and the thread-log path.
- **Existing test updated:** it asserted that a session larger than a 1-byte budget is kept. It is now archived as the sweep's one oversized group.

## Race barrier

- **The archive wins the lock:** the turn's `beforeTurn` waits for the session lock, then restores every file from R2 before it returns.
- **The turn wins the lock:** it restores and returns. Its thread is busy from the dispatch claim, so the recheck keeps the session.
- **The turn's cursor changes after discovery:** the recheck under the lock sees the busy thread and keeps the session.
- **A bridge call times out on the server's side while the root keeps going:** a later `restore-sessions` waits in the root's serial queue behind that archive.

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
- A 72 h untracked group archived while young, protected, symlinked, busy-thread and group-only sessions are kept, and nothing is archived without `referencedSessions`.
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
