# What uses a home's disk (2026-11-13)

A Cloud home can now say what fills its disk. It measures, it never deletes.

## What is measured

- Every top-level entry of the data folder (`DATA_DIR`): databases, attachments, conversation logs, saved tool results, saved engine sessions (`providers`), checkpoints, computer home folders, browser profile, skills, settings files, and any other folder by its own name ("Other home data: name").
- The dogs' work folders (`task-workspaces`): one total, the part that is rebuildable output (the `BUILD_OUTPUT_DIRS` names and `.wrangler/tmp`, as the cleaner knows them), the part that is version history (`.git`), the rest, and the ten largest dogs by id and name, the others summed.
- On the desktop only the app's own data folder is measured, never the person's home folder or the temporary folder. On a Cloud home only, the home folder around the data folder: downloaded packages (the pnpm store first, then `.npm`, `.yarn`, `.bun`, `.pnpm-store`), program caches (`.cache`), installed programs (`.local` without the store, `.nvm`, `.cargo`, `.rustup`, `.pyenv`, `.deno`, `go`), saved engine sessions (`.claude`, `.codex`, `.grok`, `.cursor`, `.kimi-code`, `.pi`, `.gemini`), web browser data (`.agent-browser`), Downloads, projects in the home folder (summed, never named), other dot folders by name, and the temporary folder when it is on the same disk.

## What is never read or reported

- No file contents: the walk only lists folders and reads each entry's size with `lstat`.
- Symlinks are counted as links and never followed. A folder on another filesystem is not entered, and an area whose root is on another disk is left out.
- No path or file name from inside a dog's work leaves the walk: rows carry an area key and a label, and per-dog rows carry only the dog's id and name. Folders in the home folder that are not dot folders are summed without names.
- A name that is not valid text is read as raw bytes, so its folder is still counted. When an entry cannot be looked at for any reason other than having vanished, the area is marked `atLeast`.
- A file with several hard links is counted once, where it is first seen. The walker remembers up to five million linked files in a compact table of inode numbers (8 bytes a slot, at most 2^23 slots: 64 MiB, briefly 96 MiB while it grows); past that, links are counted again and the area is marked `overEstimate`. The package store is walked first, so packages linked into a dog's `node_modules` count as downloaded packages, and the rebuildable output row shows only what deleting it would free on its own.

## How the home is protected

- The walk runs in a child process (`server/laterdog/disk-walk.ts`, started with `ELECTRON_RUN_AS_NODE=1` so the desktop app runs it as plain node) at the lowest CPU priority and, on Linux, the idle disk class (`ionice -c 3`); it pauses 2 ms every 2,000 entries. The server only reads one short line per area. At each pause the walker checks that its parent is still the server and exits if not, so a restart never leaves two walks running.
- Each area stops after two minutes and the whole run after ten; an area that stops early is reported with `atLeast`. The server kills a walker that is still alive 15 s after the run limit and keeps what it had, marked incomplete.
- One run at a time. It runs after each scheduled cleaner run, two minutes after start when nothing was measured before, and on `POST /api/storage/measure`.
- The result is kept in memory and in `disk-breakdown.json` in the data folder, the only thing it writes. The file is rewritten only when an area appears, disappears, changes its marks, or moves by more than 10 MB and more than 1% of its size, so an idle home does not save a new copy four times a day. After a restart the shown time may be that of the last meaningful change.

## On the wire

`GET /api/storage` gains `breakdown`: `{ at, tookMs, complete, entries: [{ area, label, bytes, atLeast?, overEstimate?, within?, dogId?, dogName? }] }`, or null. Rows with `within` are parts of another row. `POST /api/storage/measure` answers `{ started }` at once, behind the same sign-in as `POST /api/storage/clean`. Each run logs one `[storage]` line with the five largest areas in megabytes.

The desktop has no page that reads `/api/storage`, so nothing is shown there yet.

## How it was proven

`server/laterdog/disk-breakdown.test.ts` builds a temporary tree with known sizes: a dog folder with a nested `node_modules`, `.git`, `.wrangler/tmp`, a symlink to an 8 MB file outside the tree and one to an outside folder, a hard link, an unreadable folder, plus a home folder with a package store, caches, programs, engine sessions and a project. It checks the split, that links are not followed and hard links count once, the `atLeast` mark for an unreadable folder and for a folder that hits its time limit, the plan, a real child-process run, the single-run guard, that no path or file name reaches the result, the log line, the saved file and its reload after a restart, and a walker killed at the limit. It also checks a folder listable but not searchable (marked `atLeast`), a name that is not valid text (kept where the filesystem allows one; this Mac's does not), the over-estimate mark and the inode table, a walker whose parent exits (gone within three seconds), the walker's environment, and that a second run with the same numbers leaves the saved file untouched. `server/routes/storage.test.ts` checks the new route.

The real server was started from source on an isolated fixture (`node --experimental-strip-types scripts/control-laterdog.ts launch`); `GET /api/storage` and `POST /api/storage/measure` were called on it (see the report for what came back).

## Not proven

Not run on a real home. The time on a 17 GB home with many small files, the effect of the idle disk class inside a container, and whether the container's temporary folder is on the data disk are not known. Crossing to another filesystem is enforced in code but not covered by a test.
