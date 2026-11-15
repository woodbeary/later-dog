# Home upkeep

What a Cloud home cleans up by itself, and what must be seen on a real home before each part that is only watched
today is allowed to act. The code is under `server/laterdog/` (`disk-ladder.ts`, `disk-floor.ts`,
`turn-leftovers.ts`, `turn-upkeep.ts`, `chat-temp.ts`, `shared-clones.ts`, `deleted-chat-folders.ts`); tests sit
beside each file.

## Before switching what a turn leaves running from watching to stopping

`LEFTOVER_MODE` in `server/laterdog/turn-leftovers.ts` is `"observe"`. Three seconds after a chat's turn ends, with
no turn or helper still running in that chat, the home lists every process marked with the chat whose parent is not
marked with it, and logs one line:

    laterdog home: chat 1a2b3c4d finished its turn; would stop 2 process(es) it left running: 4242 node, 4250 sleep

Up to ten are named (pid and program), then `and N more`. In `"act"` the same line says `stopped` and those
processes get SIGTERM, then SIGKILL five seconds later if the same process is still there.

**Reading the lines.** The home's log goes to the Workers Logs of its container app (services and the query are in
`docs/laterdog/dev-loop.md`, "Home and Worker logs"). Filter `$metadata.message` `includes` `would stop`, on the home's service,
over the whole period. For each line keep the time, the chat (first eight characters of its id) and the programs.
The chat's events (`GET /api/threads/<chat id>/events`) show what the dog ran in that turn and the next.

**What must be seen, all of it, before `"act"`:**
1. At least seven days of lines from a home in daily use with at least ten different chats that ran shell
   commands, and at least one chat that started a server or watcher with the shell tool's own background option.
2. No line names the engine (`claude`, `codex`), an engine's MCP helper, the home's own programs (`node` running
   the server, `caddy`, `tini`), or anything started by `run_on_computer`. Any such line is a defect in
   `leftoverRoots`, fixed and observed again for seven days.
3. No line names a process the dog went on to use in its next turn: no later command in that chat reads that
   process's output, calls its port, or stops it itself. Check every line whose programs are servers or watchers
   (`node`, `vite`, `next`, `python`, `uvicorn`, `tsx`, `pnpm`, `npm`) against the next turn's events. One such case
   means a dog's deliberate background work would be killed.
4. A process started with the shell tool's background option never appears. The engine keeps those under itself,
   so they should not be listed; if one is, `"act"` would end work the dog expects to read later.
5. The dogs are told first. The system prompt (`server/system-prompt.ts`) says only that `$TMPDIR` is emptied. Before
   `"act"`, it must also say, in one sentence, that what a turn starts with `&`, `nohup`, `setsid` or `tmux` stops when
   the turn ends, and that work meant to outlive the turn uses the shell tool's background option.
6. Turns do not get slower: the time from a turn's end to the next turn's start, for back-to-back turns, is the
   same with the check on as in the days before it.

When all six hold, change the one constant to `"act"`, with a test that a listed process is ended, and keep watching
the `stopped` lines for a week.

## The disk ladder

Each rung writes one `laterdog home: disk N% free` line when it removes something; nothing is shown to the person
until the floor. Filter `includes` `laterdog home: disk` to read them. Under 10% free a heavy command is refused
(the dog reads why in the refusal); under 5% or 1 GB a shell command that writes is refused. After a pass that ran
every rung, if the disk is still under the floor, `GET /api/storage` carries the one sentence in `warning`.

On a test home, the checks that only a real home can make:
- a dog clones the same repository in three chats; `du -sh` of the three `.git` folders together is about one
  history, and `stat -c %h` of a pack file under `.git/objects/pack` in each is 4 (three copies and the cache);
- `git status`, `git pull` and `git push` in each copy behave as in a plain clone, and removing
  `~/.cache/laterdog-repos` changes nothing in them (`git fsck` stays clean);
- a dog's `which git` names the engine bin folder, and the clone helper writes nothing a dog sees beyond git's own
  lines;
- a chat is deleted: its folder appears under `deleted-chat-folders/<dog>/` at once and is gone seven days later.

## Known limit: a restore brings every copy back whole

The repository cache lives in `~/.cache`, which the home's save skips, and a restore (`restore()` in
`deploy/laterdog/home/runtime/sync.mjs`) writes every file on its own. After a home wakes from a save, each work copy
holds its full history again: three clones that took one history before the save take three after it, and a restore
of a home that was near full can need more room than the disk has. Until the restore links files whose saved pieces
are the same, check free space on a test home before and after a restore with several clones of one repository.
