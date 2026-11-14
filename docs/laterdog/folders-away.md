# Chats' files in Cloud storage

A Cloud home has one fixed disk of at most 20 GB. Most of it holds chats' work folders, and most chats go
untouched for weeks. When this is turned on, the home moves the work folder of a chat nobody has used for a
long time into its own Cloud storage, and brings it back, whole, before that chat is used again. Nobody has to
think about it. While a chat's files come back, its status line reads "Bringing this chat's files back".

It ships switched off. Nothing is moved until a home turns it on (see below).

## What moves and what never does

- One chat's folder, `task-workspaces/<dog>/<chat>`, with its version history (`.git`).
- Packed by the save's own rules (`skipped` and `heldLock` in `deploy/laterdog/home/runtime/sync.mjs`): what a
  restart would not bring back (`node_modules`, caches, `-wal`/`-shm`/`-journal` files, held `.lock` folders) is
  not carried either. The stored record lists what was left out.
- Never: a dog's own folder (`workspaces/<dog>`, memory), project folders, attachments, databases, programs,
  folders with no matching chat, folders under 1 MB.

## When

A chat qualifies when it has no turn, engine session, open ask, handoff or routine run; no routine due on it
within a day; no computer run started in its folder within a day; nobody asked for its files in the last hour;
and both its last message and its newest file are old enough.

- **Daily:** chats idle for 30 days move, oldest first.
- **Under pressure:** when less than 20% of the disk is free, chats idle for 7 days move, largest first, until
  30% is free.
- Always one folder at a time, at most 2 GB per pass. `low` (under 2 GB free) keeps its meaning.

`GET /api/storage/away-plan` shows what would move and why, without moving anything; `POST` measures again.
It answers with ids, sizes and dates only.

## How one folder moves (`runtime/folder-away.mjs`)

1. Pack: list the folder, stream every kept file into 8 MB pieces in the home's Cloud storage
   (`archive/blobs/<sha256>`), reading each piece back and checking its hash; any file that changes during
   the copy stops the move.
2. Store the record (every entry with mode, time, size and sha256; the pieces; what was left out) as one more
   piece, read it back, and check every piece is there.
3. Under the save lock (the same lock the home's save takes, so no save sees the middle): rename the folder to
   a name the save skips, list it again and compare it with the record. On any difference, rename it back,
   log it, and keep the folder. Otherwise put the marker folder in its place.
4. Log `laterdog home: moved chat <id>'s files (N files, X MB) to Cloud storage`, then delete the old copy.

The marker, `.laterdog-away.json`, is owned by root and read-only. It says what happened, when, where, the
record's checksum, and in plain words that nothing was deleted and that the files come back when the chat gets
a message or its files are opened in the app.

## Coming back

Every entry point waits until the files are back (table below). The runtime checks free space first, reads
the record, checks its checksum, rebuilds the folder in a staging folder the save skips, checks every piece and
every file, and only then, under the save lock, swaps it in, and only if the folder still holds exactly that
marker. If anything else was written there meanwhile, the files come back beside it as
`<chat>-brought-back-<id>` and the log says so.

If it fails, the marker stays, nothing half-built is left where the folder belongs, the turn stays queued, the
status line says "This chat's files are in Cloud storage and couldn't be brought back yet; trying again", and
it tries again. If there is not enough room, the home first moves other idle chats away; if that is still not
enough it says so and keeps the turn queued.

## Living with the home's save

The next save no longer lists the moved folder, so a wake does not download it. The marker is saved, so a home
rebuilt from its save still knows the folder is away. The save's clean-up only touches `blobs/`, and the edge
Worker refuses every delete under `archive/`, so stored pieces are never removed.

## What is not deleted yet

Deleting a chat or a dog does not yet remove its stored-away files. When a chat or dog is gone while its folder
is away, the home appends a line to `.laterdog/folders-away/released.ndjson` (which chat, when it moved, when it
was released, which record). A later, separately reviewed clean-up can use that list. Nothing reads it today.

## Turning it on for one home

In that home's `config.json`:

```json
{ "storage": { "foldersAway": true } }
```

Then restart the home's server. The setting cannot be changed through the settings API. With it off, chats
whose files are already away still come back as usual; only new moves stop.

## Rolling back

Never roll a home's image back automatically while folders are away. An older image cannot bring them back.

To bring every folder back first, call, signed in as the home's owner:

```sh
curl -fsS -X POST -H "authorization: Bearer $HOME_TOKEN" https://<home>/api/storage/folders/bring-back
```

It checks free space before it starts and stops with a plain message, changing nothing, when there is not
enough room. Otherwise it brings each chat back and reports any that could not come back yet.

The runtime refuses pushed server code that cannot bring folders back while any are away. It runs the image's
server instead, and its `laterdog home:` log line says how many chats are away and names this command.

## Storage report

`GET /api/storage` → `archive.folders`: `supported`, `enabled`, `away` (chats), `bytes`, `released`, a plain
`line` ("12 chats' files are kept in Cloud storage (3.5 GB) and come back when the chat is used."), and the
last pass (`lastMove`). The desktop app has no view of a home's disk today, so the line is in the report only.

## Every reader and writer of a chat's folder

| Use | Where | Status | Why / test |
| --- | --- | --- | --- |
| A new turn, including routines, helpers, continuations and follow-ups | `server/index.ts`, direct dispatch, beside `logArchive.beforeTurn` | Gated | Covers the chat folder and the pinned working folder. `folder-away-server.test.ts`: the turn waits through an outage, then runs on the restored folder |
| Group turn run in a guest's chat folder | `runGroupMemberTurn`, before `ensureTaskWorkspace` | Gated | `ensureChatFolder` with the turn's cancel. The gate itself is tested in `server/laterdog/folder-away.test.ts`; this call site has no test of its own yet |
| Files opened in the app | `POST /api/threads/:t/messages/:m/file` | Gated | `folder-away-server.test.ts`: opening a linked file brings the folder back first |
| A dog attaching a file from its folder | `/api/internal/attach-file` | Gated | Runs inside a turn, so the folder is already back; `ensurePaths` checks the roots again. This call site has no test of its own yet |
| A computer run that starts in the folder | `routes/computer-run.ts` (`ready`) | Gated | `computer-run.test.ts`: waits, and refuses plainly when the files are not back |
| Engine on the Mac or a dog's computer syncing the folder | `engine-remote.ts`, `engine-relay.ts` | Covered by the turn gate | Only runs inside a turn |
| Device approval and command checks | `ownerGuardContext`, device-approval route, `commandAllowlistResponse` | Untouched | Compare paths only, read no files |
| Turn results and checkpoints | `observedTurnResults`, `checkpointCwd` | Untouched | Results run at the end of a turn; private chat folders get no checkpoints (`checkpointCwd` is unset for them) |
| Janitor: build output, space maker, stray processes | `janitor.ts`, `space-maker.ts`, `process-reaper` | Untouched | They only delete rebuildable output, and a marker folder holds none |
| Disk report | `disk-breakdown.ts` | Untouched | Counts the marker's few bytes; the moved bytes show in `archive.folders` |
| What-would-move report | `folder-away-plan.ts` | Marker-aware | Reports `already-away` |
| Deleting a chat or a dog | `store.deleteTask`, `store.deleteBot` | Marker-aware | Neither removes chat folders today; the sweep writes the release record (`folder-away.test.ts`, both) |
| Copying a dog, search and recall indexing | `dog-share.ts`, `bot-package.ts`, `cross-dog-recall.ts`, memory index | Untouched | None of them reads chat folders |
| Workspace export | `workspace-backup.ts` | Marker-aware | An export from a home carries the marker, not the files; bring folders back first to export them |
| Moving a Mac's workspace to the Cloud | `cloud-move-profile.ts` | Untouched | Leaves `task-workspaces` on the Mac; desktop only |
| A teammate's own shell reading the folder | engine processes | Marker-aware | Cannot be intercepted; the marker's note says what happened and how the files come back |

## Proven on fixtures only

Every claim above is proven on fixtures: a fake store that injects faults, the home's real save and restore
code on temporary folders, and a disposable server with a fake engine. None of it has run on a real home or
against real Cloud storage. Before turning it on for a real home: run it on a test home, measure the
what-would-move report on the real home, and time the return of its largest candidate.
