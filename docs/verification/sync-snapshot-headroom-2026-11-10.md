# Home save: database copy headroom and scratch cleanup (2026-11-10)

## Measured on the home (read-only, 2026-11-10 02:20 to 02:25 UTC)

- `/` and `/data` share one 19,228,708,864-byte disk.
- Steady free space was about 700 to 735 MB. Each minute it dropped by 589 to 590 MB for about 20 to 25 s (dips at 02:21:59, 02:22:54 and 02:24:06), down to 110 to 145 MB. Root read 141,316,096 bytes at 02:25:11, inside a dip.
- `messages.db` was 589,414,400 bytes and its WAL 4,791,592 bytes. Neither changed during the dips.
- No readable process held a deleted file over 50 MB, and no new file over 100 MB appeared under `/data`, `/tmp` or `/var`.
- Inferred, not observed at file level: `runtime/run.mjs` saves every 60 s, and `snapshot` copies each changed SQLite file with SQLite's backup into `/tmp/laterdog-sync`. That folder is root-owned with mode 700 and its mtime moved with the dips. The size and rhythm match `messages.db`.

## Change

`runtime/sync.mjs` only:

- Before copying a changed database, `snapshot` reads free space on the scratch filesystem (`statfs`, `bavail * bsize`). It copies only when free space is at least the database size plus its current WAL size plus `SNAPSHOT_RESERVE_BYTES` (256 MiB).
- Without room, the save keeps the previous manifest entry exactly (chunks, size, mtime, stamp), lists the path in `unsaved`, and carries on with the other files. A database with no previous entry gets no entry. A later normal save copies it once there is room.
- The copy is removed in `finally`, so a failed upload no longer leaves it in scratch until the next save. A failed SQLite backup removes its partial copy before the error is reported. The error handling, the `unsaved` list and the kept entry behave as before.
- `freeBytes` is an optional `snapshot` argument for tests. The default reads the real filesystem.

The full SQLite backup stays, because it is what gives a consistent copy that includes rows still in the WAL. These were considered and rejected:

- Skipping databases entirely would stop saving chat history.
- Copying the raw file would miss WAL rows or capture a torn file.
- Holding a read transaction while streaming would block checkpoints for the whole upload.

## Fails closed

If free space cannot be read, is not a finite number, or the WAL cannot be inspected for a reason other than not existing, the database is not copied. It is handled the same as no room: the previous entry is kept and the path is listed in `unsaved`.

## Why 256 MiB

The reserve protects other writers while the copy exists, which is about 20 to 25 s per save on the home. The largest single burst measured in this inventory was a git fetch that wrote two 233 MB packs in 11 s. Background growth from thread logs and transcripts was about 300 MB over 6 h. 256 MiB covers one such burst. It is a best-effort preflight, not a reservation: another writer can still take the space between the check and the copy.

## What this means on the home today

With about 700 to 735 MB free, the requirement is roughly 589 MB + 5 MB + 256 MiB, about 860 MB. Once this ships, saves will skip `messages.db` until free space rises above that. The saved copy of `messages.db` stays at its last successful save while every other file keeps saving. This guard stops the copy from filling the disk; it does not reduce net disk growth or clear the low-space warning.

## Visibility

A skipped database appears only in the runtime log on stderr: `could not save N file(s) this time, first messages.db; the next save tries again`. That line doesn't give the reason. There is no route, health field or UI alert for it.

## Tests

Node 24.22.2 and pnpm 10.33.0 on Kennel's cloud computer. New cases in `test/sync.test.ts` use real temporary SQLite databases in WAL mode with autocheckpoint off:

1. Scratch one byte short of database + WAL + reserve: no copy (scratch is empty when free space is read and afterwards), previous entry kept exactly, `unsaved` is `messages.db`, an ordinary file still saves, and a restore gives the old rows. With exactly enough room, the next save restores the new rows.
2. Free space that can't be read, or reads as NaN: no copy, previous entry kept, listed in `unsaved`.
3. First save with no room: no entry for the database.
4. After a no-room save, a save measuring the real disk restores rows that are still only in the WAL.
5. Upload failure: scratch is empty afterwards, the previous entry is kept, and the next save restores the new rows.
6. SQLite backup failure on a non-database `.db` file: scratch is empty, other files save, and the source file is untouched.

Before (base `25762902` source with the new tests): 4 failed and 35 passed without case 2, then 5 failed and 35 passed with it. Case 4 passes on the base because the base always copies.
After: `sync` and `restore-points` 51 of 51.
