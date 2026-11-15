# Running the engines as their own user

Today a dog cannot signal the home's server because a shell hook refuses the command
(`server/laterdog/home-signals.ts`). A hook reads the command's text, so it can be got round: a script that calls
`os.kill`, a program the dog wrote, or a command spelled in a way the reader does not know. This note says what it
would take for the kernel to refuse instead. No code; nothing here is built.

## How a home runs today

- `tini` is pid 1 and runs `run.mjs` (the launcher: saves, restores, pushed code) as root.
- The launcher starts `cloud-home-start.js` as root. That drops to the `dog` user (`SERVICE_USER` in
  `server/cloud-home-start.ts`) for the server and the edge, after checking that the code it runs is not on the data
  volume (`codeTrustProblem`).
- The server starts every engine (the coding engine and its shell, its tools, everything a dog runs) as its own
  child, so they all run as `dog` too.

So the root processes are already out of a dog's reach. The server is not: it and every engine share one uid, and
the kernel lets a process signal anything with its uid. Every chat's processes also share that uid, so one dog can
stop another's work.

## What would change

**The image.** Add a user for engines, for example `engine` (uid 1001), and a group both share, for example
`laterdog` (the server's `dog` and `engine` both members). The server keeps running as `dog`.

**Starting an engine.** The server is not root, so it cannot use `spawn`'s `uid` option. Three ways, best first:
1. A one-line sudo rule: `dog ALL=(engine) NOPASSWD: /app/cloud/runtime/engine-exec`, where `engine-exec` is a short
   program in the image (owned by root, not on the volume) that clears the environment it was not given, sets
   `umask 007`, and runs the engine. `sudo -u engine` keeps the pipes the server talks to the engine through. The
   server's spawn of an engine changes in one place (both drivers already build the command and the environment).
2. A small root helper started by `cloud-home-start.js` before it drops to `dog`, that starts engines on request and
   passes their pipes back. More code, no sudo.
3. File capabilities on node: rejected. They would apply to every node program, including those the dogs run.

**File ownership.** Everything both sides touch must be readable and writable by the group:
- the data folder's chat folders (`task-workspaces`), the chats' temp folders (`laterdog-chats`), the engine bin
  folder and the repository cache (`~/.cache/laterdog-repos`): group `laterdog`, folders `2770` (setgid so new files
  keep the group), files made under `umask 007`;
- files the server writes for an engine to read: the MCP configuration and settings in the engine's temp folder, the
  hook token files (`hook-tokens/`, today `0600`): `0640`, group `laterdog`;
- the engines' own sign-in folders (`.claude`, `.codex` and the rest under `HOME`): owned by `engine`, since the
  engine refreshes its own sign-in; the server reads them only through the engine;
- the save: `restore()` in `deploy/laterdog/home/runtime/sync.mjs` sets every file's owner to `dog`. It would set the
  owner each path should have (`engine` under the engines' sign-in folders, `dog` elsewhere, group `laterdog`
  everywhere), and the first start after the change fixes the owner of files already on the volume.
- hard links: the kernel's `protected_hardlinks` setting lets a user link only files it owns or can write. The
  repository cache is created by the engine's own `git`, so its files belong to `engine` and the links still work.

**The hook.** With engines as `engine`, the kernel refuses any signal to the server, its launcher and pid 1, however
it is sent. The hook's checks for those become a second line and its message the explanation the dog reads. The
hook still matters between chats, since all engines share `engine`: a dog could stop another chat's work. Separating
chats too means one uid per engine (a small pool, `engine-0` to `engine-N`, given out by the server), with each
chat's folder owned by its engine's uid; that doubles the ownership work above and is a later step.

## What it would cost and break

- Every place the server reads a file an engine wrote (tool results, uploads, a dog's work for Storage and saves)
  depends on the group bits; a dog that runs `chmod 600` on its own files hides them from the server, which must
  fail softly (skip and log), not crash.
- Codex runs its own sandbox on the home (`server/laterdog/codex-container-sandbox.ts`); its rules must allow the
  group folders.
- On the Mac nothing changes: the desktop runs engines as the person, and that stays.

## How it would be checked

On a test home only: a dog runs `kill -TERM <server pid>` through a script the hook does not read (`python3 -c
'import os; os.kill(<pid>, 15)'`) and gets `PermissionError`; a turn, a save, a restore and a repository clone
still work; `ls -ln` of a chat folder shows the group and modes above.
